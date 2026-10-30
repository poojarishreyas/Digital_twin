import {useEffect, useRef, useState, type ReactNode} from 'react'
import {Icon} from './icons'

export function Modal({title, subtitle, onClose, children, width = 560}: {title: string; subtitle?: string; onClose: () => void; children: ReactNode; width?: number}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLElement>('input, select, button')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div ref={box} className="modal card" role="dialog" aria-modal="true" aria-label={title} style={{maxWidth: width}}>
      <div className="card-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={16}/></button></div>
      <div className="card-body">{children}</div>
    </div>
  </div>
}

/** Read-only value with a copy button; for one-time secrets and install commands. */
export function CopyField({value, label, multiline = false, secret = false}: {value: string; label?: string; multiline?: boolean; secret?: boolean}) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { /* clipboard blocked */ }
  }
  return <div className="copy-field">
    {label && <span className="copy-label">{label}</span>}
    <div className="copy-row">
      {multiline ? <pre className="code" style={{flex: 1, margin: 0}}>{value}</pre> : <code className={`copy-value ${secret ? 'secret' : ''}`}>{value}</code>}
      <button className="btn sm" onClick={() => void copy()} aria-label={`Copy ${label ?? 'value'}`}><Icon name={copied ? 'check' : 'file'} size={14}/>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  </div>
}
