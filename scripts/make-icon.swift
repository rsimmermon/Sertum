// Renders the AgentStation placeholder app icon to a 1024x1024 PNG.
// Placeholder art: a dark slate squircle with a cyan ">_" prompt, chosen to
// read clearly at 16pt and to be obviously distinct from Electron's atom.
// Replace assets/icon.png (or this script) once real artwork exists.
import AppKit

let side = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/icon.png"

guard let ctx = CGContext(
    data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("could not create bitmap context") }

func rgb(_ r: Int, _ g: Int, _ b: Int) -> CGColor {
    CGColor(red: CGFloat(r)/255, green: CGFloat(g)/255, blue: CGFloat(b)/255, alpha: 1)
}

// macOS icons sit inside a transparent margin rather than filling the canvas.
let inset: CGFloat = 88
let tile = CGRect(x: inset, y: inset, width: CGFloat(side) - inset*2, height: CGFloat(side) - inset*2)
let squircle = CGPath(roundedRect: tile, cornerWidth: 208, cornerHeight: 208, transform: nil)

ctx.saveGState()
ctx.addPath(squircle)
ctx.clip()
let gradient = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [rgb(0x33, 0x41, 0x55), rgb(0x0F, 0x17, 0x2A)] as CFArray,
    locations: [0, 1]
)!
ctx.drawLinearGradient(gradient,
                       start: CGPoint(x: 0, y: tile.maxY),
                       end: CGPoint(x: 0, y: tile.minY),
                       options: [])
ctx.restoreGState()

// ">_" prompt, drawn as strokes so it needs no font.
ctx.setStrokeColor(rgb(0x22, 0xD3, 0xEE))
ctx.setLineWidth(82)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.beginPath()
ctx.move(to: CGPoint(x: 352, y: 648))
ctx.addLine(to: CGPoint(x: 500, y: 512))
ctx.addLine(to: CGPoint(x: 352, y: 376))
ctx.strokePath()

ctx.setStrokeColor(rgb(0xE2, 0xE8, 0xF0))
ctx.beginPath()
ctx.move(to: CGPoint(x: 556, y: 386))
ctx.addLine(to: CGPoint(x: 680, y: 386))
ctx.strokePath()

guard let image = ctx.makeImage() else { fatalError("could not render image") }
let rep = NSBitmapImageRep(cgImage: image)
rep.size = NSSize(width: side, height: side)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("could not encode png") }
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
