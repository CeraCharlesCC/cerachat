import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { useMemo } from 'react'

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })

export function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => DOMPurify.sanitize(markdown.render(content)), [content])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
