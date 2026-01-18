import { NextRequest, NextResponse } from 'next/server'
import { json2csv } from 'json-2-csv'

interface DomainResult {
  domain: string
  tld: string
  status: 'Available' | 'Taken' | 'Error'
  error?: string
}

interface ExportRequest {
  results: DomainResult[]
}

export async function POST(req: NextRequest) {
  try {
    const body: ExportRequest = await req.json()
    const { results } = body

    if (!results || !Array.isArray(results) || results.length === 0) {
      return NextResponse.json(
        { error: 'No results provided' },
        { status: 400 }
      )
    }

    // Group results by domain and create CSV data
    const domainsMap = new Map<string, Record<string, string>>()
    
    // Get all unique TLDs
    const tlds = Array.from(new Set(results.map(r => r.tld))).sort()
    
    // Build domain map
    results.forEach(result => {
      if (!domainsMap.has(result.domain)) {
        domainsMap.set(result.domain, {
          'Domain Name': result.domain,
          ...Object.fromEntries(tlds.map(tld => [tld, '']))
        })
      }
      
      const domainData = domainsMap.get(result.domain)!
      domainData[result.tld] = result.status
    })

    // Convert to array
    const csvData = Array.from(domainsMap.values())

    // Generate CSV
    const csv = json2csv(csvData, {
      prependHeader: true,
      sortHeader: false,
    })

    // Create response with CSV download
    const response = new NextResponse(csv)
    response.headers.set('Content-Type', 'text/csv')
    response.headers.set('Content-Disposition', `attachment; filename="domain-check-results-${Date.now()}.csv"`)
    
    return response
  } catch (error) {
    console.error('CSV export error:', error)
    return NextResponse.json(
      { error: 'Failed to export CSV' },
      { status: 500 }
    )
  }
}
