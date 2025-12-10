import net from 'node:net'
import { executionAsyncId } from 'node:async_hooks'
import {
  type HeadersCallback,
  HTTPParser,
  type RequestHeadersCompleteCallback,
  type ResponseHeadersCompleteCallback,
} from '_http_common'
import { STATUS_CODES, IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { invariant } from 'outvariant'
import { INTERNAL_REQUEST_ID_HEADER_NAME } from '../../Interceptor'
import { MockSocket } from '../Socket/MockSocket'
import type { NormalizedSocketWriteArgs } from '../Socket/utils/normalizeSocketWriteArgs'
import { isPropertyAccessible } from '../../utils/isPropertyAccessible'
import { baseUrlFromConnectionOptions } from '../Socket/utils/baseUrlFromConnectionOptions'
import { createServerErrorResponse } from '../../utils/responseUtils'
import { createRequestId } from '../../createRequestId'
import { getRawFetchHeaders } from './utils/recordRawHeaders'
import { FetchResponse } from '../../utils/fetchUtils'
import { setRawRequest } from '../../getRawRequest'
import { setRawRequestBodyStream } from '../../utils/node'

// ANSI colors
const C = {
  RESET: '\x1b[0m',
  CYAN: '\x1b[36m',
  YELLOW: '\x1b[33m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  GRAY: '\x1b[90m',
  WHITE: '\x1b[97m',
}

// Hash string to consistent color
function hashColor(str: string): string {
  const hash = str.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  const colorKeys = [C.CYAN, C.YELLOW, C.GREEN, C.MAGENTA, C.BLUE]
  return colorKeys[hash % colorKeys.length]
}

// Create a logger bound to a socket ID with consistent coloring
function createSocketLogger(socketID: string) {
  const idColor = hashColor(socketID)
  const prefix = `${idColor}[🔧${socketID}]${C.RESET}`
  const t0 = performance.now()

  return {
    log: (msg: string) => {
      const elapsed = (performance.now() - t0).toFixed(3).padStart(10)
      const tick = executionAsyncId()
      const tickColor = hashColor(String(tick))
      console.error(`${C.GRAY}${elapsed}ms${C.RESET} [⏱️${tickColor}${tick}${C.RESET}] ${prefix} ${msg}`)
    },
    h: hashColor,
  }
}


type HttpConnectionOptions = any

export type MockHttpSocketRequestCallback = (args: {
  requestId: string
  request: Request
  socket: MockHttpSocket
}) => void

export type MockHttpSocketResponseCallback = (args: {
  requestId: string
  request: Request
  response: Response
  isMockedResponse: boolean
  socket: MockHttpSocket
}) => Promise<void>

interface MockHttpSocketOptions {
  connectionOptions: HttpConnectionOptions
  createConnection: () => net.Socket
  onRequest: MockHttpSocketRequestCallback
  onResponse: MockHttpSocketResponseCallback
}

export const kRequestId = Symbol('kRequestId')

export class MockHttpSocket extends MockSocket {
  [x: string]: any
  private connectionOptions: HttpConnectionOptions
  private createConnection: () => net.Socket
  private baseUrl: URL

  private onRequest: MockHttpSocketRequestCallback
  private onResponse: MockHttpSocketResponseCallback
  private responseListenersPromise?: Promise<void>

  private requestRawHeadersBuffer: Array<string> = []
  private responseRawHeadersBuffer: Array<string> = []
  private writeBuffer: Array<NormalizedSocketWriteArgs> = []
  private request?: Request
  private requestParser: HTTPParser<0>
  private requestStream?: Readable
  private shouldKeepAlive?: boolean

  private socketState: 'unknown' | 'mock' | 'passthrough' = 'unknown'
  private responseParser: HTTPParser<1>
  private responseStream?: Readable
  private originalSocket?: net.Socket
  private log!: ReturnType<typeof createSocketLogger>

  constructor(options: MockHttpSocketOptions) {
    // CRITICAL: Initialize socketID and logger FIRST, before super()
    // because write callbacks can fire synchronously during super() construction
    const socketID = Math.random().toString(36).slice(2)
    const log = createSocketLogger(socketID)
    log.log(`🏗️  constructor starting`)

    super({
      write: (chunk, encoding, callback) => {
        log.log(
          `✍️  write ${C.BLUE}${Buffer.isBuffer(chunk) ? chunk.length : String(chunk).length
          }b${C.RESET} 🇺🇸=${C.YELLOW}${this.socketState}${C.RESET} buffered=${this.writeBuffer.length
          }`
        )
        // Buffer the writes so they can be flushed in case of the original connection
        // and when reading the request body in the interceptor. If the connection has
        // been established, no need to buffer the chunks anymore, they will be forwarded.
        if (this.socketState !== 'passthrough') {
          this.writeBuffer.push([chunk, encoding, callback])
        }

        if (chunk) {
          /**
           * Forward any writes to the mock socket to the underlying original socket.
           * This ensures functional duplex connections, like WebSocket.
           * @see https://github.com/mswjs/interceptors/issues/682
           */
          if (this.socketState === 'passthrough') {
            this.log.log(
              `🔀 forwarding ${C.BLUE}${Buffer.isBuffer(chunk) ? chunk.length : String(chunk).length
              }b${C.RESET} to originalSocket`
            )
            this.originalSocket?.write(chunk, encoding, callback)
          }

          this.requestParser.execute(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
          )
        }
      },
      read: (chunk) => {
        if (chunk !== null) {
          /**
           * @todo We need to free the parser if the connection has been
           * upgraded to a non-HTTP protocol. It won't be able to parse data
           * from that point onward anyway. No need to keep it in memory.
           */
          this.responseParser.execute(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          )
        }
      },
    })

    this.socketID = socketID
    this.log = log

    this.connectionOptions = options.connectionOptions
    this.createConnection = options.createConnection
    this.onRequest = options.onRequest
    this.onResponse = options.onResponse

    this.baseUrl = baseUrlFromConnectionOptions(this.connectionOptions)
    this.log.log(
      `🏗️  constructor complete ${C.GRAY}${this.baseUrl.href}${C.RESET}`
    )

    // Request parser.
    this.requestParser = new HTTPParser()
    this.requestParser.initialize(HTTPParser.REQUEST, {})
    this.requestParser[HTTPParser.kOnHeaders] = this.onRequestHeaders.bind(this)
    this.requestParser[HTTPParser.kOnHeadersComplete] =
      this.onRequestStart.bind(this)
    this.requestParser[HTTPParser.kOnBody] = this.onRequestBody.bind(this)
    this.requestParser[HTTPParser.kOnMessageComplete] =
      this.onRequestEnd.bind(this)

    // Response parser.
    this.responseParser = new HTTPParser()
    this.responseParser.initialize(HTTPParser.RESPONSE, {})
    this.responseParser[HTTPParser.kOnHeaders] =
      this.onResponseHeaders.bind(this)
    this.responseParser[HTTPParser.kOnHeadersComplete] =
      this.onResponseStart.bind(this)
    this.responseParser[HTTPParser.kOnBody] = this.onResponseBody.bind(this)
    this.responseParser[HTTPParser.kOnMessageComplete] =
      this.onResponseEnd.bind(this)

    // Once the socket is finished, nothing can write to it
    // anymore. It has also flushed any buffered chunks.
    this.once('finish', () => this.requestParser.free())

    if (this.baseUrl.protocol === 'https:') {
      Reflect.set(this, 'encrypted', true)
      // The server certificate is not the same as a CA
      // passed to the TLS socket connection options.
      Reflect.set(this, 'authorized', false)
      Reflect.set(this, 'getProtocol', () => 'TLSv1.3')
      Reflect.set(this, 'getSession', () => undefined)
      Reflect.set(this, 'isSessionReused', () => false)
    }

    // Intercept key socket methods for debugging
    this._interceptSocketMethods()
  }

  private _interceptSocketMethods(): void {
    const intercept = (
      method: string,
      emoji: string,
      handler?: (result: any, ...args: any[]) => void
    ) => {
      const original = (this as any)[method]?.bind(this)
      if (!original) return
        ; (this as any)[method] = (...args: any[]) => {
          this.log.log(
            `${emoji} ${C.MAGENTA}${method}${C.RESET}(${args.length > 0
              ? C.GRAY + JSON.stringify(args).slice(0, 40) + C.RESET
              : ''
            })`
          )
          const result = original(...args)
          handler?.(result, ...args)
          return result
        }
    }

    // Critical for understanding flow
    intercept('connect', '🔌')
    intercept('end', '🛑')
    intercept('pause', '⏸️')
    intercept('resume', '▶️')
    intercept('ref', '📌')
    intercept('unref', '📍')

    // These are cheap and might reveal issues
    intercept('setTimeout', '⏲️')
    intercept('setKeepAlive', '💚')
    intercept('setNoDelay', '⚡')

    // pipe/unpipe can be relevant for streams
    intercept('pipe', '🔀', (result, dest) => {
      this.log.log(`  └─ piping to ${dest?.constructor?.name || 'unknown'}`)
    })
    intercept('unpipe', '🔀', (result, dest) => {
      this.log.log(`  └─ unpiping from ${dest?.constructor?.name || 'all'}`)
    })

    // Stream methods
    intercept('read', '📖')
    intercept('push', '📤')
    intercept('unshift', '📥')
  }

  public _read(size: number): void {
    this.log.log(
      `🔬 _read(${C.BLUE}${size}${C.RESET}) ⏳=${this.connecting} 🔐=${this.encrypted} 🇺🇸=${C.YELLOW}${this.socketState}${C.RESET} 🔗=${C.GRAY}${this.baseUrl.href}${C.RESET} origFlowing=${this.originalSocket?.readableFlowing}`
    )

    if (process.env.MSW_USE_FIX === 'true') {
      if (this.socketState === 'passthrough') {
        // console.warn(' _read noop in passthrough mode')
        return
      }
    }

    // console.warn(' _read calling super')
    super._read(size)
  }

  public emit(event: string | symbol, ...args: any[]): boolean {
    const eventStr = String(event)
    this.log.log(
      `📣 emit ${this.log.h(eventStr)}${eventStr}${C.RESET} ${args
        .map((arg) => {
          return Buffer.isBuffer(arg)
            ? String(arg).replace(/[^\x20-\x7E\n\r\t]/g, '?').length + ' chars'
            : JSON.stringify(arg)
        })
        .join(', ')}`
    )
    const emitEvent = super.emit.bind(this, event as any, ...args)

    if (this.responseListenersPromise) {
      this.responseListenersPromise.finally(emitEvent)
      return this.listenerCount(event) > 0
    }

    return emitEvent()
  }

  public destroy(error?: Error | undefined): this {
    this.log.log(
      `🧨 _destroy ⏳=${this.connecting} 🔐=${this.encrypted} 🇺🇸=${C.YELLOW}${this.socketState
      }${C.RESET} 🔗=${C.GRAY}${this.baseUrl.href}${C.RESET}${error ? ` ⛔️=${C.RED}${JSON.stringify(error)}${C.RESET}` : ''
      }`
    )

    // Destroy the response parser when the socket gets destroyed.
    // Normally, we should listen to the "close" event but it
    // can be suppressed by using the "emitClose: false" option.
    this.responseParser.free()

    if (error) {
      this.emit('error', error)
    }

    return super.destroy(error)
  }

  /**
   * Establish this Socket connection as-is and pipe
   * its data/events through this Socket.
   */
  public passthrough(): void {
    this.log.log(`💨 passthrough() 🧨=${this.destroyed} ⏳=${this.connecting}`)
    this.socketState = 'passthrough'

    if (this.destroyed) {
      this.log.log(`💨 passthrough() but ${C.RED}destroyed${C.RESET}: bailing`)
      return
    }

    const socket = this.createConnection()
    this.originalSocket = socket
    this.log.log(`🔌 created ${C.GREEN}originalSocket${C.RESET}`)

    /**
     * @note Inherit the original socket's connection handle.
     * Without this, each push to the mock socket results in a
     * new "connection" listener being added (i.e. buffering pushes).
     * @see https://github.com/nodejs/node/blob/b18153598b25485ce4f54d0c5cb830a9457691ee/lib/net.js#L734
     */
    if ('_handle' in socket) {
      // Monkey-patch the handle to log interactions
      // We cannot use a Proxy because V8 internals (SetInternalField) explode
      // when dealing with a Proxy wrapping a native handle.
      const originalHandle = (socket as any)._handle
      if (originalHandle && !originalHandle._isInstrumented) {
        const log = this.log
        const methods = ['readStart', 'readStop', 'close']

        for (const method of methods) {
          const original = originalHandle[method]
          if (typeof original === 'function') {
            originalHandle[method] = function (this: any, ...args: any[]) {
              log.log(`🔧 HANDLE.${method}()`)
              const stack = new Error().stack?.split('\n').slice(2, 10) || []
              for (const line of stack) {
                log.log(`${C.GRAY}${line}${C.RESET}`)
              }
              return original.apply(this, args)
            }
          }
        }
        originalHandle._isInstrumented = true
      }

      Object.defineProperty(this, '_handle', {
        value: originalHandle,
        enumerable: true,
        writable: true,
      })
    }

    // If the developer destroys the socket, destroy the original connection.
    this.once('error', (error) => {
      this.log.log(
        `⛔️ ${C.RED}error event${C.RESET} emitted, will destroy socket`
      )
      const stack = new Error().stack?.split('\n').slice(2, 10) || []
      for (const line of stack) {
        this.log.log(`${C.GRAY}${line}${C.RESET}`)
      }

      this.log.log(`${C.RED}Error Details:${C.RESET}`)
      this.log.log(`${C.RED}${error.message}${C.RESET}`)
      if (error.stack) {
        for (const line of error.stack.split('\n')) {
          this.log.log(`${C.RED}${line}${C.RESET}`)
        }
      }
      socket.destroy(error)
    })

    this.address = socket.address.bind(socket)

    // Flush the buffered "socket.write()" calls onto
    // the original socket instance (i.e. write request body).
    // Exhaust the "requestBuffer" in case this Socket
    // gets reused for different requests.
    let writeArgs: NormalizedSocketWriteArgs | undefined
    let headersWritten = false

    this.log.log(
      `🚽 flushing writeBuffer (${C.BLUE}${this.writeBuffer.length}${C.RESET} items)`
    )

    while ((writeArgs = this.writeBuffer.shift())) {
      if (writeArgs !== undefined) {
        if (!headersWritten) {
          const [chunk, encoding, callback] = writeArgs
          const chunkString = chunk.toString()
          const chunkBeforeRequestHeaders = chunkString.slice(
            0,
            chunkString.indexOf('\r\n') + 2
          )
          const chunkAfterRequestHeaders = chunkString.slice(
            chunk.indexOf('\r\n\r\n')
          )
          const rawRequestHeaders = getRawFetchHeaders(this.request!.headers)
          const requestHeadersString = rawRequestHeaders
            // Skip the internal request ID deduplication header.
            .filter(([name]) => {
              return name.toLowerCase() !== INTERNAL_REQUEST_ID_HEADER_NAME
            })
            .map(([name, value]) => `${name}: ${value}`)
            .join('\r\n')

          // Modify the HTTP request message headers
          // to reflect any changes to the request headers
          // from the "request" event listener.
          const headersChunk = `${chunkBeforeRequestHeaders}${requestHeadersString}${chunkAfterRequestHeaders}`
          socket.write(headersChunk, encoding, callback)
          headersWritten = true
          continue
        }

        socket.write(...writeArgs)
      }
    }

    // Forward TLS Socket properties onto this Socket instance
    // in the case of a TLS/SSL connection.
    if (Reflect.get(socket, 'encrypted')) {
      const tlsProperties = [
        'encrypted',
        'authorized',
        'getProtocol',
        'getSession',
        'isSessionReused',
      ]

      tlsProperties.forEach((propertyName) => {
        Object.defineProperty(this, propertyName, {
          enumerable: true,
          get: () => {
            const value = Reflect.get(socket, propertyName)
            return typeof value === 'function' ? value.bind(socket) : value
          },
        })
      })
    }

    socket
      .on('lookup', (...args) => {
        this.log.log(
          `🔍 ${this.log.h('lookup')}onLookup${C.RESET} ${C.GRAY
          }args=${JSON.stringify(args).slice(0, 60)}${C.RESET}`
        )
        this.emit('lookup', ...args)
      })
      .on('connect', () => {
        this.log.log(
          `🔌 ${this.log.h('connect')}onConnect${C.RESET} ${C.GRAY
          }delay from lookup${C.RESET}`
        )

        // Check for stale handle (Happy Eyeballs hypothesis)
        const currentHandle = (socket as any)._handle
        const myHandle = (this as any)._handle
        if (currentHandle !== myHandle) {
          this.log.log(`${C.RED}⚠️  HANDLE MISMATCH!${C.RESET}`)
          this.log.log(`   My Handle: ${myHandle?.constructor?.name} 🔧=${!!myHandle?._isInstrumented} 🆔=${myHandle?.fd} 📖=${myHandle?.reading}`)
          this.log.log(`   Socket Handle: ${currentHandle?.constructor?.name} 🔧=${!!currentHandle?._isInstrumented} 🆔=${currentHandle?.fd} 📖=${currentHandle?.reading}`)
          this.log.log(`   ${C.RED}Object references are different!${C.RESET}`)
        } else {
          this.log.log(`${C.GREEN}✅ Handles match${C.RESET}`)
        }

        this.connecting = socket.connecting
        this.emit('connect')
      })
      .on('secureConnect', () => {
        this.log.log(
          `🔒 ${this.log.h('secureConnect')}onSecureConnect${C.RESET}`
        )
        this.emit('secureConnect')
      })
      .on('secure', () => {
        this.log.log(`🔒 ${this.log.h('secure')}onSecure${C.RESET}`)
        this.emit('secure')
      })
      .on('session', (session) => {
        this.log.log(`🧾 ${this.log.h('session')}onSession${C.RESET}`)
        this.emit('session', process.env.NOISY === 'true' ? session : '')
      })
      .on('ready', () => {
        this.log.log(`✅ ${this.log.h('ready')}onReady${C.RESET}`)
        this.emit('ready')
      })
      .on('drain', () => {
        this.log.log(`💧 ${this.log.h('drain')}onDrain${C.RESET}`)
        this.emit('drain')
      })
      .on('data', (chunk) => {
        // print sanitized
        this.log.log(
          `💾 ${this.log.h('data')}onData${C.RESET} ${C.BLUE}${chunk.length}b${C.RESET
          }${process.env.NOISY === 'true'
            ? ' ' + String(chunk).replace(/[^\x20-\x7E\n\r\t]/g, '?')
            : ''
          }`
        )
        // Push the original response to this socket
        // so it triggers the HTTP response parser. This unifies
        // the handling pipeline for original and mocked response.
        this.push(chunk)
      })
      .on('error', (error) => {
        this.log.log(
          `💥 ${this.log.h('error')}onError${C.RESET} ${C.RED}${String(
            error
          ).replace(/[^\x20-\x7E\n\r\t]/g, '?')}${C.RESET}`
        )
        Reflect.set(this, '_hadError', Reflect.get(socket, '_hadError'))
        this.emit('error', error)
      })
      .on('resume', () => {
        this.log.log(`▶️ ${this.log.h('resume')}onResume${C.RESET}`)
        this.emit('resume')
      })
      .on('timeout', () => {
        this.log.log(`⏰ ${this.log.h('timeout')}onTimeout${C.RESET}`)
        this.emit('timeout')
      })
      .on('prefinish', () => {
        this.log.log(`⏳ ${this.log.h('prefinish')}onPrefinish${C.RESET}`)
        this.emit('prefinish')
      })
      .on('finish', () => {
        this.log.log(`✅ ${this.log.h('finish')}onFinish${C.RESET}`)
        this.emit('finish')
      })
      .on('close', (hadError) => {
        this.log.log(
          `💥 ${this.log.h('close')}onClose${C.RESET} 🧨=${hadError}`
        )
        this.emit('close', hadError)
      })
      .on('end', () => {
        this.log.log(`🛑 ${this.log.h('end')}onEnd${C.RESET}`)
        this.emit('end')
      })
  }

  /**
   * Convert the given Fetch API `Response` instance to an
   * HTTP message and push it to the socket.
   */
  public async respondWith(response: Response): Promise<void> {
    const statusColor =
      response.status < 300 ? C.GREEN : response.status < 400 ? C.YELLOW : C.RED
    this.log.log(
      `📤 respondWith status=${statusColor}${response.status}${C.RESET} 🧨=${this.destroyed} 🇺🇸=${C.YELLOW}${this.socketState}${C.RESET}`
    )
    // Ignore the mocked response if the socket has been destroyed
    // (e.g. aborted or timed out),
    if (this.destroyed) {
      this.log.log(
        `📤 respondWith: socket ${C.RED}destroyed${C.RESET}, bailing`
      )
      return
    }

    // Handle "type: error" responses.
    if (isPropertyAccessible(response, 'type') && response.type === 'error') {
      this.errorWith(new TypeError('Network error'))
      return
    }

    // First, emit all the connection events
    // to emulate a successful connection.
    this.mockConnect()
    this.socketState = 'mock'
    this.log.log(`🎭 socketState → ${C.YELLOW}mock${C.RESET}`)

    // Flush the write buffer to trigger write callbacks
    // if it hasn't been flushed already (e.g. someone started reading request stream).
    this.flushWriteBuffer()

    // Create a `ServerResponse` instance to delegate HTTP message parsing,
    // Transfer-Encoding, and other things to Node.js internals.
    const serverResponse = new ServerResponse(new IncomingMessage(this))

    /**
     * Assign a mock socket instance to the server response to
     * spy on the response chunk writes. Push the transformed response chunks
     * to this `MockHttpSocket` instance to trigger the "data" event.
     * @note Providing the same `MockSocket` instance when creating `ServerResponse`
     * does not have the same effect.
     * @see https://github.com/nodejs/node/blob/10099bb3f7fd97bb9dd9667188426866b3098e07/test/parallel/test-http-server-response-standalone.js#L32
     */
    serverResponse.assignSocket(
      new MockSocket({
        write: (chunk, encoding, callback) => {
          this.push(chunk, encoding)
          callback?.()
        },
        read() { },
      })
    )

    /**
     * @note Remove the `Connection` and `Date` response headers
     * injected by `ServerResponse` by default. Those are required
     * from the server but the interceptor is NOT technically a server.
     * It's confusing to add response headers that the developer didn't
     * specify themselves. They can always add these if they wish.
     * @see https://www.rfc-editor.org/rfc/rfc9110#field.date
     * @see https://www.rfc-editor.org/rfc/rfc9110#field.connection
     */
    serverResponse.removeHeader('connection')
    serverResponse.removeHeader('date')

    const rawResponseHeaders = getRawFetchHeaders(response.headers)

    /**
     * @note Call `.writeHead` in order to set the raw response headers
     * in the same case as they were provided by the developer. Using
     * `.setHeader()`/`.appendHeader()` normalizes header names.
     */
    serverResponse.writeHead(
      response.status,
      response.statusText || STATUS_CODES[response.status],
      rawResponseHeaders
    )

    // If the developer destroy the socket, gracefully destroy the response.
    this.once('error', () => {
      serverResponse.destroy()
    })

    if (response.body) {
      try {
        const reader = response.body.getReader()

        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            serverResponse.end()
            break
          }

          serverResponse.write(value)
        }
      } catch (error) {
        // Coerce response stream errors to 500 responses.
        this.respondWith(createServerErrorResponse(error))
        return
      }
    } else {
      serverResponse.end()
    }

    // Close the socket if the connection wasn't marked as keep-alive.
    if (!this.shouldKeepAlive) {
      this.log.log(`🔒 closing socket (no keep-alive)`)
      this.emit('readable')

      /**
       * @todo @fixme This is likely a hack.
       * Since we push null to the socket, it never propagates to the
       * parser, and the parser never calls "onResponseEnd" to close
       * the response stream. We are closing the stream here manually
       * but that shouldn't be the case.
       */
      this.responseStream?.push(null)
      this.push(null)
    }
  }

  /**
   * Close this socket connection with the given error.
   */
  public errorWith(error?: Error): void {
    this.log.log(
      `💣 errorWith ${error ? C.RED + error.message + C.RESET : 'no error'}`
    )
    this.destroy(error)
  }

  private mockConnect(): void {
    this.log.log(
      `🎭 mockConnect() ⏳=${this.connecting} 🇺🇸=${C.YELLOW}${this.socketState}${C.RESET}`
    )
    // Calling this method immediately puts the socket
    // into the connected state.
    this.connecting = false

    const isIPv6 =
      net.isIPv6(this.connectionOptions.hostname) ||
      this.connectionOptions.family === 6
    const addressInfo = {
      address: isIPv6 ? '::1' : '127.0.0.1',
      family: isIPv6 ? 'IPv6' : 'IPv4',
      port: this.connectionOptions.port,
    }
    // Return fake address information for the socket.
    this.address = () => addressInfo
    this.emit(
      'lookup',
      null,
      addressInfo.address,
      addressInfo.family === 'IPv6' ? 6 : 4,
      this.connectionOptions.host
    )
    this.emit('connect')
    this.emit('ready')

    if (this.baseUrl.protocol === 'https:') {
      this.emit('secure')
      this.emit('secureConnect')

      // A single TLS connection is represented by two "session" events.
      this.emit(
        'session',
        this.connectionOptions.session ||
        Buffer.from('mock-session-renegotiate')
      )
      this.emit('session', Buffer.from('mock-session-resume'))
    }
  }

  private flushWriteBuffer(): void {
    const callbackCount = this.writeBuffer.filter(
      (w) => typeof w[2] === 'function'
    ).length
    if (callbackCount > 0) {
      this.log.log(
        `🚿 flushWriteBuffer() callbacks=${C.BLUE}${callbackCount}${C.RESET}/${C.BLUE}${this.writeBuffer.length}${C.RESET}`
      )
    }
    for (const writeCall of this.writeBuffer) {
      if (typeof writeCall[2] === 'function') {
        writeCall[2]()
        /**
         * @note Remove the callback from the write call
         * so it doesn't get called twice on passthrough
         * if `request.end()` was called within `request.write()`.
         * @see https://github.com/mswjs/interceptors/issues/684
         */
        writeCall[2] = undefined
      }
    }
  }

  /**
   * This callback might be called when the request is "slow":
   * - Request headers were fragmented across multiple TCP packages;
   * - Request headers were too large to be processed in a single run
   * (e.g. more than 30 request headers).
   * @note This is called before request start.
   */
  private onRequestHeaders: HeadersCallback = (rawHeaders) => {
    this.requestRawHeadersBuffer.push(...rawHeaders)
  }

  private onRequestStart: RequestHeadersCompleteCallback = (
    versionMajor,
    versionMinor,
    rawHeaders,
    _,
    path,
    __,
    ___,
    ____,
    shouldKeepAlive
  ) => {
    this.log.log(
      `🚀 onRequestStart path=${C.GRAY}${path}${C.RESET} keepAlive=${shouldKeepAlive}`
    )
    this.shouldKeepAlive = shouldKeepAlive

    const url = new URL(path || '', this.baseUrl)
    const method = this.connectionOptions.method?.toUpperCase() || 'GET'
    const headers = FetchResponse.parseRawHeaders([
      ...this.requestRawHeadersBuffer,
      ...(rawHeaders || []),
    ])
    this.requestRawHeadersBuffer.length = 0

    const canHaveBody = method !== 'GET' && method !== 'HEAD'

    // Translate the basic authorization in the URL to the request header.
    // Constructing a Request instance with a URL containing auth is no-op.
    if (url.username || url.password) {
      if (!headers.has('authorization')) {
        headers.set('authorization', `Basic ${url.username}:${url.password}`)
      }
      url.username = ''
      url.password = ''
    }

    // Create a new stream for each request.
    // If this Socket is reused for multiple requests,
    // this ensures that each request gets its own stream.
    // One Socket instance can only handle one request at a time.
    this.requestStream = new Readable({
      /**
       * @note Provide the `read()` method so a `Readable` could be
       * used as the actual request body (the stream calls "read()").
       * We control the queue in the onRequestBody/End functions.
       */
      read: () => {
        // If the user attempts to read the request body,
        // flush the write buffer to trigger the callbacks.
        // This way, if the request stream ends in the write callback,
        // it will indeed end correctly.
        this.flushWriteBuffer()
      },
    })

    const requestId = createRequestId()
    this.request = new Request(url, {
      method,
      headers,
      credentials: 'same-origin',
      // @ts-expect-error Undocumented Fetch property.
      duplex: canHaveBody ? 'half' : undefined,
      body: canHaveBody ? (Readable.toWeb(this.requestStream!) as any) : null,
    })

    Reflect.set(this.request, kRequestId, requestId)

    // Set the raw `http.ClientRequest` instance on the request instance.
    // This is useful for cases like getting the raw headers of the request.
    setRawRequest(this.request, Reflect.get(this, '_httpMessage'))

    // Create a copy of the request body stream and store it on the request.
    // This is only needed for the consumers who wish to read the request body stream
    // of requests that cannot have a body per Fetch API specification (i.e. GET, HEAD).
    setRawRequestBodyStream(this.request, this.requestStream)

    // Skip handling the request that's already being handled
    // by another (parent) interceptor. For example, XMLHttpRequest
    // is often implemented via ClientRequest in Node.js (e.g. JSDOM).
    // In that case, XHR interceptor will bubble down to the ClientRequest
    // interceptor. No need to try to handle that request again.
    /**
     * @fixme Stop relying on the "X-Request-Id" request header
     * to figure out if one interceptor has been invoked within another.
     * @see https://github.com/mswjs/interceptors/issues/378
     */
    if (this.request.headers.has(INTERNAL_REQUEST_ID_HEADER_NAME)) {
      this.log.log(
        `🔁 ${C.MAGENTA}internal request${C.RESET} detected, passing through`
      )
      this.passthrough()
      return
    }

    this.onRequest({
      requestId,
      request: this.request,
      socket: this,
    })
  }

  private onRequestBody(chunk: Buffer): void {
    this.log.log(`📦 onRequestBody ${C.BLUE}${chunk.length}b${C.RESET}`)
    invariant(
      this.requestStream,
      'Failed to write to a request stream: stream does not exist'
    )

    this.requestStream.push(chunk)
  }

  private onRequestEnd(): void {
    this.log.log(`🏁 onRequestEnd hasStream=${!!this.requestStream}`)
    // Request end can be called for requests without body.
    if (this.requestStream) {
      this.requestStream.push(null)
    }
  }

  /**
   * This callback might be called when the response is "slow":
   * - Response headers were fragmented across multiple TCP packages;
   * - Response headers were too large to be processed in a single run
   * (e.g. more than 30 response headers).
   * @note This is called before response start.
   */
  private onResponseHeaders: HeadersCallback = (rawHeaders) => {
    this.responseRawHeadersBuffer.push(...rawHeaders)
  }

  private onResponseStart: ResponseHeadersCompleteCallback = (
    versionMajor,
    versionMinor,
    rawHeaders,
    method,
    url,
    status,
    statusText
  ) => {
    const statusColor = status < 300 ? C.GREEN : status < 400 ? C.YELLOW : C.RED
    this.log.log(
      `📨 onResponseStart status=${statusColor}${status}${C.RESET} 🇺🇸=${C.YELLOW}${this.socketState}${C.RESET}`
    )
    const headers = FetchResponse.parseRawHeaders([
      ...this.responseRawHeadersBuffer,
      ...(rawHeaders || []),
    ])
    this.responseRawHeadersBuffer.length = 0

    const response = new FetchResponse(
      /**
       * @note The Fetch API response instance exposed to the consumer
       * is created over the response stream of the HTTP parser. It is NOT
       * related to the Socket instance. This way, you can read response body
       * in response listener while the Socket instance delays the emission
       * of "end" and other events until those response listeners are finished.
       */
      FetchResponse.isResponseWithBody(status)
        ? (Readable.toWeb(
          (this.responseStream = new Readable({ read() { } }))
        ) as any)
        : null,
      {
        url,
        status,
        statusText,
        headers,
      }
    )

    invariant(
      this.request,
      'Failed to handle a response: request does not exist'
    )

    FetchResponse.setUrl(this.request.url, response)

    /**
     * @fixme Stop relying on the "X-Request-Id" request header
     * to figure out if one interceptor has been invoked within another.
     * @see https://github.com/mswjs/interceptors/issues/378
     */
    if (this.request.headers.has(INTERNAL_REQUEST_ID_HEADER_NAME)) {
      return
    }

    this.responseListenersPromise = this.onResponse({
      response,
      isMockedResponse: this.socketState === 'mock',
      requestId: Reflect.get(this.request, kRequestId),
      request: this.request,
      socket: this,
    })
  }

  private onResponseBody(chunk: Buffer) {
    this.log.log(`📥 onResponseBody ${C.BLUE}${chunk.length}b${C.RESET}`)
    invariant(
      this.responseStream,
      'Failed to write to a response stream: stream does not exist'
    )

    this.responseStream.push(chunk)
  }

  private onResponseEnd(): void {
    this.log.log(`🎬 onResponseEnd hasStream=${!!this.responseStream}`)
    // Response end can be called for responses without body.
    if (this.responseStream) {
      this.responseStream.push(null)
    }
  }
}
