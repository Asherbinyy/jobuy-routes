type HeifFrame = {
  get_width(): number
  get_height(): number
  display(output: ImageData, finished: (data: ImageData | null) => void): void
  free(): void
}

const asset = (name: string) => new URL(`${import.meta.env.BASE_URL}ocr/${name}`, document.baseURI).href

export async function browserReadablePhoto(blob: Blob, filename = '') {
  if (!/^image\/hei[cf](?:-sequence)?$/i.test(blob.type) && !/\.hei[cf]$/i.test(filename)) return blob
  const { default: load } = await import(/* @vite-ignore */ asset('libheif.mjs')) as {
    default: () => Promise<{ HeifDecoder: new () => { decode(bytes: Uint8Array): HeifFrame[] } }>
  }
  const library = await load()
  const decoder = new library.HeifDecoder()
  const frames = decoder.decode(new Uint8Array(await blob.arrayBuffer()))
  const frame = frames[0]
  if (!frame) throw new Error('The HEIC photo could not be read. Try a PNG or JPEG copy.')
  try {
    const width = frame.get_width()
    const height = frame.get_height()
    if (width <= 0 || height <= 0 || width * height > 30_000_000) throw new Error('Choose a cropped photo or a smaller screenshot.')
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The browser could not prepare this photo.')
    const pixels = await new Promise<ImageData>((resolve, reject) => {
      frame.display(context.createImageData(width, height), output => {
        if (output) resolve(output)
        else reject(new Error('The HEIC photo could not be read. Try a PNG or JPEG copy.'))
      })
    })
    context.putImageData(pixels, 0, 0)
    context.globalCompositeOperation = 'destination-over'
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(output => output ? resolve(output) : reject(new Error('The browser could not prepare this photo.')), 'image/png')
    })
  } finally {
    for (const image of frames) image.free()
  }
}

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

function labelCrop(image: HTMLCanvasElement, area: 'waybill' | 'address') {
  const canvas = document.createElement('canvas')
  const waybill = area === 'waybill'
  const width = Math.ceil(image.width * (waybill ? 1 : 0.7))
  const height = Math.ceil(image.height * (waybill ? 0.24 : 0.3))
  const scale = Math.min(2, 1600 / width)
  canvas.width = Math.ceil(width * scale)
  canvas.height = Math.ceil(height * scale)
  const context = canvas.getContext('2d')
  if (!context) return image
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.translate(canvas.width / 2, canvas.height / 2)
  if (waybill) context.rotate(-0.14)
  else context.filter = 'grayscale(1) contrast(1.3) brightness(1.1)'
  context.drawImage(image, 0, Math.floor(image.height * (waybill ? 0.16 : 0.51)), width, height,
    -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height)
  return canvas
}

export async function recognizeImage(blob: Blob, progress: (label: string) => void, needsSecondRead?: (text: string) => boolean) {
  const image = await prepareImage(await browserReadablePhoto(blob))
  const { createWorker, OEM, PSM } = await import('tesseract.js')
  const base = asset('')
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
      const detail: string[] = []
      if (needsSecondRead?.(data.text)) {
        progress('Taking a second look at the label…')
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK })
        const portrait = image.height > image.width
        detail.push((await worker.recognize(portrait ? labelCrop(image, 'waybill') : image)).data.text)
        if (portrait) detail.push((await worker.recognize(labelCrop(image, 'address'))).data.text)
      }
      return { text: data.text, confidence: Math.round(data.confidence), detail }
    }
    return await Promise.race([reading(), stopped])
  } finally {
    clearTimeout(timer)
    await worker?.terminate()
  }
}
