'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Download, Search, Check, X, AlertCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const DEFAULT_TLDS = ['.com', '.net', '.io', '.ai', '.dev']

interface DomainResult {
  domain: string
  tld: string
  status: 'Available' | 'Taken' | 'Error'
  error?: string
}

export default function Home() {
  const [domainInput, setDomainInput] = useState('')
  const [selectedTlds, setSelectedTlds] = useState<string[]>(DEFAULT_TLDS.map(tld => tld.replace('.', '')))
  const [results, setResults] = useState<DomainResult[]>([])
  const [isChecking, setIsChecking] = useState(false)
  const [progress, setProgress] = useState(0)

  const handleTldToggle = (tld: string) => {
    setSelectedTlds(prev => 
      prev.includes(tld) 
        ? prev.filter(t => t !== tld)
        : [...prev, tld]
    )
  }

  const handleCheck = async () => {
    if (!domainInput.trim()) {
      alert('Please enter at least one domain')
      return
    }

    if (selectedTlds.length === 0) {
      alert('Please select at least one TLD')
      return
    }

    const domains = domainInput
      .split('\n')
      .map(d => d.trim())
      .filter(d => d.length > 0)

    setIsChecking(true)
    setProgress(0)
    setResults([])

    try {
      const response = await fetch('/api/check-domains', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          domains,
          tlds: selectedTlds.map(tld => tld.startsWith('.') ? tld : `.${tld}`),
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to check domains')
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      if (!reader) {
        throw new Error('No response stream')
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6))

            if (data.type === 'progress') {
              setProgress(data.progress)
            } else if (data.type === 'complete') {
              setResults(data.results)
            } else if (data.type === 'error') {
              alert(data.error)
            }
          }
        }
      }
    } catch (error) {
      console.error('Error checking domains:', error)
      alert('Failed to check domains. Please try again.')
    } finally {
      setIsChecking(false)
    }
  }

  const handleExport = async () => {
    try {
      const response = await fetch('/api/export-csv', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ results }),
      })

      if (!response.ok) {
        throw new Error('Failed to export CSV')
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `domain-check-results-${Date.now()}.csv`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (error) {
      console.error('Error exporting CSV:', error)
      alert('Failed to export CSV. Please try again.')
    }
  }

  const getResultsByDomain = () => {
    const domainMap = new Map<string, Map<string, DomainResult>>()
    
    results.forEach(result => {
      if (!domainMap.has(result.domain)) {
        domainMap.set(result.domain, new Map())
      }
      domainMap.get(result.domain)!.set(result.tld, result)
    })
    
    return domainMap
  }

  const domainMap = getResultsByDomain()
  const sortedDomains = Array.from(domainMap.keys()).sort()
  const sortedTlds = selectedTlds.map(tld => tld.startsWith('.') ? tld : `.${tld}`).sort()

  const getStatusIcon = (result?: DomainResult) => {
    if (!result) return null
    
    if (result.status === 'Available') {
      return <Check className="h-4 w-4 text-green-500" />
    } else if (result.status === 'Taken') {
      return <X className="h-4 w-4 text-red-500" />
    } else {
      return <AlertCircle className="h-4 w-4 text-yellow-500" />
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold text-slate-900">Domain Checker</h1>
          <p className="text-slate-600">Check domain availability across multiple TLDs</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>Select TLDs</CardTitle>
              <CardDescription>Choose the extensions to check</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {DEFAULT_TLDS.map(tld => (
                  <div key={tld} className="flex items-center space-x-2">
                    <Checkbox
                      id={tld}
                      checked={selectedTlds.includes(tld.replace('.', ''))}
                      onCheckedChange={() => handleTldToggle(tld.replace('.', ''))}
                    />
                    <Label htmlFor={tld} className="text-sm font-medium">
                      {tld}
                    </Label>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Enter Domains</CardTitle>
              <CardDescription>Paste one domain per line (without TLD)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                placeholder="example1&#10;example2&#10;example3"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                className="min-h-[200px] font-mono text-sm"
              />
              
              {isChecking && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Checking domains...</span>
                    <span>{Math.round(progress)}%</span>
                  </div>
                  <Progress value={progress} />
                </div>
              )}
              
              <div className="flex gap-2">
                <Button 
                  onClick={handleCheck} 
                  disabled={isChecking}
                  className="flex-1"
                >
                  {isChecking ? (
                    <>
                      <Search className="mr-2 h-4 w-4 animate-spin" />
                      Checking...
                    </>
                  ) : (
                    <>
                      <Search className="mr-2 h-4 w-4" />
                      Check Availability
                    </>
                  )}
                </Button>
                
                {results.length > 0 && (
                  <Button 
                    onClick={handleExport}
                    variant="outline"
                    disabled={isChecking}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export CSV
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {results.length > 0 && (
          <TooltipProvider>
            <Card>
            <CardHeader>
              <CardTitle>Results</CardTitle>
              <CardDescription>
                {sortedDomains.length} domain{sortedDomains.length !== 1 ? 's' : ''} checked across {sortedTlds.length} TLD{sortedTlds.length !== 1 ? 's' : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[200px]">Domain</TableHead>
                      {sortedTlds.map(tld => (
                        <TableHead key={tld} className="text-center min-w-[100px]">
                          {tld}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedDomains.map(domain => (
                      <TableRow key={domain}>
                        <TableCell className="font-medium">{domain}</TableCell>
                        {sortedTlds.map(tld => {
                          const result = domainMap.get(domain)?.get(tld)
                          return (
                            <TableCell key={tld} className="text-center">
                              {result?.status === 'Error' ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div className="flex items-center justify-center gap-2 cursor-help">
                                      {getStatusIcon(result)}
                                      <span className="text-sm">
                                        {result.status}
                                      </span>
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>{result.error || 'Unknown error'}</p>
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                <div className="flex items-center justify-center gap-2">
                                  {getStatusIcon(result)}
                                  <span className="text-sm">
                                    {result?.status}
                                  </span>
                                </div>
                              )}
                            </TableCell>
                          )
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
          </TooltipProvider>
        )}
      </div>
    </div>
  )
}
