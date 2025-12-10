const http = require('http')

/**
 * Mock Datadog Telemetry Server
 *
 * This server mimics the Datadog agent to avoid needing real API keys.
 * It accepts all dd-trace telemetry requests and returns empty JSON responses.
 */

const handler = (req, res) => {
  const chunks = []

  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    // Respond with empty JSON (dd-trace expects JSON responses)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
    })
    res.end('{}')
  })

  req.on('error', (err) => {
    console.error('Request error:', err)
  })
}

// Start HTTP server on port 8126 (default Datadog agent port)
const server = http.createServer(handler)
server.listen(8126, () => {
  console.log('🎯 Mock Datadog server listening on port 8126')
})

process.on('SIGINT', () => {
  server.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  server.close()
  process.exit(0)
})
