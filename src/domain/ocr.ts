async function prepareImage(blob: Blob) {
  const image = new Image()
  const url = URL.createObjectURL(blob)
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('The browser could not open this image. Try a PNG or JPEG screenshot.'))
      image.src = url
    })
    const scale = Math.min(1, 2800 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(image.naturalWidth * scale)
    canvas.height = Math.round(image.naturalHeight * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The browser could not prepare this image.')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally { URL.revokeObjectURL(url) }
}

export async function recognizeImage(blob: Blob, progress: (label: string) => void) {
  const image = await prepareImage(blob)
  const { createWorker, OEM, PSM } = await import('tesseract.js')
  const base = new URL(`${import.meta.env.BASE_URL}ocr/`, document.baseURI).href
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Image reading timed out. Try a smaller crop or paste the text.')), 120000)
    })
    const reading = async () => {
      worker = await createWorker('eng', OEM.LSTM_ONLY, {
        langPath: base, corePath: base, workerPath: new URL('worker.min.js', base).href, workerBlobURL: false,
        logger(message) {
          progress(message.status === 'recognizing text' ? `Reading text · ${Math.round(message.progress * 100)}%` : 'Preparing image reading…')
        },
      })
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' })
      const { data } = await worker.recognize(image)
      return { text: data.text, confidence: Math.round(data.confidence) }
    }
    return await Promise.race([reading(), stopped])
  } finally {
    clearTimeout(timer)
    await worker?.terminate()
  }
}
