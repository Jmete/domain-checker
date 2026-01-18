import { NextRequest, NextResponse } from 'next/server'
import { promises as dnsPromises } from 'dns'

export const runtime = 'nodejs'

const TLD_CHECK_LIMIT = 10 // requests per second
const CHECK_DELAY = 1000 / TLD_CHECK_LIMIT // 100ms between checks

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

async function checkDomain(domain: string, tld: string): Promise<DomainResult> {
  const fullDomain = `${domain}.${tld}`
  
  try {
    // Try to resolve the domain using DNS
    await dnsPromises.resolve4(fullDomain)
    
    // If resolve succeeds, domain exists (taken)
    return {
      domain,
      tld,
      status: 'Taken'
    }
  } catch (error: any) {
    if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
      // Domain not found in DNS, likely available
      return {
        domain,
        tld,
        status: 'Available'
      }
    } else if (error.code === 'ETIMEOUT') {
      // Timeout error
      return {
        domain,
        tld,
        status: 'Error',
        error: 'Timeout'
      }
    } else {
      // Other errors
      return {
        domain,
        tld,
        status: 'Error',
        error: error.message || 'Unknown error'
      }
    }
  }
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
