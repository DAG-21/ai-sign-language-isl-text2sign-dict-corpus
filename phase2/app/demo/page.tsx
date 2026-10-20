import type { Metadata } from 'next'
import { GlossDemo } from '@/components/sign/GlossDemo'
import './demo.css'

export const metadata: Metadata = { title: 'ISL demo' }

export default function DemoPage() {
  return <GlossDemo />
}
