export const uid = () => crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')

export function today() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts()
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${date.year}-${date.month}-${date.day}`
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function csv(rows: (string | number)[][]) {
  return rows.map(row => row.map(value => {
    const text = String(value)
    const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(text) ? `'${text}` : text
    return `"${safe.replace(/"/g, '""')}"`
  }).join(',')).join('\r\n')
}

export async function copyText(text: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* Try selection-based copy in browsers that disallow clipboard access. */ }
  }
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.style.position = 'fixed'
  field.style.left = '-10000px'
  document.body.append(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  return copied
}
