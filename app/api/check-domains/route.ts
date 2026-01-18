import { NextRequest, NextResponse } from 'next/server'
import { promises as dnsPromises, Resolver } from 'dns'
import { request } from 'http'
import { request as httpsRequest } from 'https'

export const runtime = 'nodejs'

const TLD_CHECK_LIMIT = 20 // requests per second
const CHECK_DELAY = 1000 / TLD_CHECK_LIMIT // 50ms between checks

interface CheckRequest {
  domains: string[]
  tlds: string[]
}

interface DomainResult {
  domain: string
  tld: string
  status: 'Available' | 'Taken' | 'Error'
  error?: string
}

interface CheckResult {
  success: boolean
  method: string
  error?: string
}

function tryResolveAny(domain: string, resolver?: Resolver): Promise<CheckResult> {
  return new Promise((resolve) => {
    const callback = (err: any) => {
      if (err) {
        resolve({ success: false, method: 'resolveAny', error: err.message || err.code })
      } else {
        resolve({ success: true, method: 'resolveAny' })
      }
    }

    if (resolver) {
      resolver.resolveAny(domain, callback)
    } else {
      dnsPromises.resolveAny(domain)
        .then(() => resolve({ success: true, method: 'resolveAny' }))
        .catch((err: any) => resolve({ success: false, method: 'resolveAny', error: err.message || err.code }))
    }
  })
}

async function tryHttpCheck(fullDomain: string, timeout = 2000): Promise<CheckResult> {
  return new Promise((resolve) => {
    const isHttps = false
    const protocol = isHttps ? httpsRequest : request
    
    const options = {
      hostname: fullDomain,
      method: 'HEAD',
      timeout: timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }

    const req = protocol(options, (res: any) => {
      req.destroy()
      resolve({ success: true, method: 'HTTP' })
    })

    req.on('error', (err: any) => {
      resolve({ success: false, method: 'HTTP', error: err.message || err.code })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ success: false, method: 'HTTP', error: 'ETIMEOUT' })
    })

    req.end()
  })
}

async function checkDomainWithFallbacks(domain: string, tld: string): Promise<DomainResult> {
  const normalizedTld = tld.startsWith('.') ? tld.slice(1) : tld
  const fullDomain = `${domain}.${normalizedTld}`

  // Stage 1: Try system DNS with resolveAny
  const systemResult = await tryResolveAny(fullDomain)
  if (systemResult.success) {
    return { domain, tld, status: 'Taken' }
  }

  // Stage 2: Try Google DNS with resolveAny
  const googleResolver = new Resolver()
  googleResolver.setServers(['8.8.8.8', '8.8.4.4'])
  const googleResult = await tryResolveAny(fullDomain, googleResolver)
  if (googleResult.success) {
    return { domain, tld, status: 'Taken' }
  }

  // Analyze errors to determine final status
  const systemError = systemResult.error || ''
  const googleError = googleResult.error || ''

  // Specific error messages based on error type
  const isTimeout = systemError.includes('ETIMEOUT') && googleError.includes('ETIMEOUT')
  const isServerError = systemError.includes('ESERVFAIL') && googleError.includes('ESERVFAIL')
  const isConnError = systemError.includes('ECONNREFUSED') || systemError.includes('EAI_AGAIN')
  const googleNotFound = googleError.includes('ENOTFOUND') || googleError.includes('ENODATA')

  // If Google DNS confirms not found, try HTTP as fallback to catch domains with no DNS but web servers
  if (googleNotFound) {
    const httpResult = await tryHttpCheck(fullDomain)
    
    // If HTTP succeeds (any response), domain has a web server → Taken
    if (httpResult.success) {
      return { domain, tld, status: 'Taken' }
    }
    
    // If HTTP also fails with connection refused + DNS not found → Available
    const httpError = httpResult.error || ''
    const httpConnRefused = httpError.includes('ECONNREFUSED') || 
                           httpError.includes('ENOTFOUND') || 
                           httpError.includes('ENETUNREACH')
    
    if (httpConnRefused) {
      return { domain, tld, status: 'Available' }
    }
    
    // HTTP timed out or had other issues
    return { 
      domain, 
      tld, 
      status: 'Error', 
      error: 'HTTP timeout - try again later' 
    }
  }

  // Both DNS servers failed with transient errors - try Cloudflare DNS
  if (isTimeout || isServerError || isConnError) {
    const cloudflareResolver = new Resolver()
    cloudflareResolver.setServers(['1.1.1.1', '1.0.0.1'])
    const cloudflareResult = await tryResolveAny(fullDomain, cloudflareResolver)
    
    if (cloudflareResult.success) {
      return { domain, tld, status: 'Taken' }
    }

    const cloudflareError = cloudflareResult.error || ''
    const cloudflareNotFound = cloudflareError.includes('ENOTFOUND') || cloudflareError.includes('ENODATA')
    
    // If Cloudflare DNS says not found, try HTTP as fallback
    if (cloudflareNotFound) {
      const httpResult = await tryHttpCheck(fullDomain)
      
      if (httpResult.success) {
        return { domain, tld, status: 'Taken' }
      }
      
      const httpError = httpResult.error || ''
      const httpConnRefused = httpError.includes('ECONNREFUSED') || 
                             httpError.includes('ENOTFOUND') || 
                             httpError.includes('ENETUNREACH')
      
      if (httpConnRefused) {
        return { domain, tld, status: 'Available' }
      }
      
      return { 
        domain, 
        tld, 
        status: 'Error', 
        error: 'HTTP timeout - try again later' 
      }
    }

    // All DNS servers failed with transient errors
    const errorMsg = isTimeout ? 'DNS timeout - try again later' : 
                     isServerError ? 'DNS server error - try again later' : 
                     'DNS connection error - try again later'
    return { domain, tld, status: 'Error', error: errorMsg }
  }

  // Fallback for other error cases
  return { 
    domain, 
    tld, 
    status: 'Error', 
    error: 'DNS lookup failed' 
  }
}

async function checkDomain(domain: string, tld: string): Promise<DomainResult> {
  return checkDomainWithFallbacks(domain, tld)
}

async function checkDomainsWithRateLimit(
  domains: string[],
  tlds: string[],
  onProgress: (progress: number) => void
): Promise<DomainResult[]> {
  const results: DomainResult[] = []
  const totalChecks = domains.length * tlds.length
  let checksCompleted = 0

  for (const domain of domains) {
    for (const tld of tlds) {
      const result = await checkDomain(domain.trim(), tld)
      results.push(result)
      checksCompleted++
      
      // Update progress
      onProgress((checksCompleted / totalChecks) * 100)
      
      // Rate limiting delay
      if (checksCompleted < totalChecks) {
        await new Promise(resolve => setTimeout(resolve, CHECK_DELAY))
      }
    }
  }

  return results
}

export async function POST(req: NextRequest) {
  try {
    const body: CheckRequest = await req.json()
    const { domains, tlds } = body

    // Validate input
    if (!domains || !Array.isArray(domains) || domains.length === 0) {
      return NextResponse.json(
        { error: 'No domains provided' },
        { status: 400 }
      )
    }

    if (!tlds || !Array.isArray(tlds) || tlds.length === 0) {
      return NextResponse.json(
        { error: 'No TLDs provided' },
        { status: 400 }
      )
    }

    // Create a Server-Sent Events response
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const onProgress = (progress: number) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'progress', progress })}\n\n`)
            )
          }

          const results = await checkDomainsWithRateLimit(domains, tlds, onProgress)
          
          // Send final results
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'complete', results })}\n\n`)
          )
          
          controller.close()
        } catch (error) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', error: 'Failed to check domains' })}\n\n`)
          )
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400 }
    )
  }
}
