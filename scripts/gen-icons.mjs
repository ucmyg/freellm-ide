// Renders build/icon.svg into the raster sizes electron-builder and the
// renderer need. Run with `npm run icons` after editing the SVG.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'build')
const svg = await readFile(path.join(buildDir, 'icon.svg'))

await mkdir(buildDir, { recursive: true })

// electron-builder derives every platform icon from this one.
const mainPng = path.join(buildDir, 'icon.png')
await sharp(svg, { density: 384 }).resize(1024, 1024).png().toFile(mainPng)

// Windows .ico needs its own set of embedded sizes.
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoBuffers = await Promise.all(
  icoSizes.map((size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()),
)
await writeFile(path.join(buildDir, 'icon.ico'), await pngToIco(icoBuffers))

console.log(`wrote ${mainPng} and icon.ico (${icoSizes.join(', ')})`)
