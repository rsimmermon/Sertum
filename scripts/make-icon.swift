// Renders the Sertum app icon to a 1024x1024 PNG.
//
// Sertum is Latin for a garland — a bound chain of separate elements — so the
// mark is a hexagon built from six unconnected segments: distinct agent
// sessions aligned into one boundary. A single gold segment stands for the
// session that currently holds focus.
//
// Drawn as straight strokes rather than a typeface or freehand path, so it
// stays exact at every size. Segment weight and gap size are deliberate: the
// finer constellation-of-dots alternative collapsed into a smudge at 16pt,
// which is the size that matters most in a Dock and a tab strip.
import AppKit

let side = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/icon.png"

func rgb(_ r: Int, _ g: Int, _ b: Int) -> CGColor {
    CGColor(red: CGFloat(r)/255, green: CGFloat(g)/255, blue: CGFloat(b)/255, alpha: 1)
}

guard let ctx = CGContext(
    data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("could not create bitmap context") }

// macOS icons sit inside a transparent margin rather than filling the canvas.
let inset: CGFloat = 88
let tile = CGRect(x: inset, y: inset, width: CGFloat(side) - inset*2, height: CGFloat(side) - inset*2)

ctx.saveGState()
ctx.addPath(CGPath(roundedRect: tile, cornerWidth: 208, cornerHeight: 208, transform: nil))
ctx.clip()
let gradient = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [rgb(0x24, 0x28, 0x2F), rgb(0x0B, 0x0D, 0x10)] as CFArray,
    locations: [0, 1]
)!
ctx.drawLinearGradient(gradient,
                       start: CGPoint(x: 0, y: tile.maxY),
                       end: CGPoint(x: 0, y: tile.minY),
                       options: [])
ctx.restoreGState()

let centre = CGFloat(side) / 2
let radius: CGFloat = 300
let gap: CGFloat = 0.11          // fraction trimmed from each end of a segment
let ink = rgb(0xF2, 0xF4, 0xF7)
let gold = rgb(0xE3, 0xB3, 0x41)

var corners: [CGPoint] = []
for i in 0..<6 {
    let angle = (.pi / 2) + CGFloat(i) / 6 * 2 * .pi
    corners.append(CGPoint(x: centre + cos(angle) * radius, y: centre + sin(angle) * radius))
}

ctx.setLineWidth(38)
ctx.setLineCap(.butt)            // square ends keep the gaps crisp when scaled
for i in 0..<6 {
    let from = corners[i]
    let to = corners[(i + 1) % 6]
    let start = CGPoint(x: from.x + (to.x - from.x) * gap, y: from.y + (to.y - from.y) * gap)
    let end = CGPoint(x: from.x + (to.x - from.x) * (1 - gap), y: from.y + (to.y - from.y) * (1 - gap))
    ctx.setStrokeColor(i == 0 ? gold : ink)
    ctx.beginPath()
    ctx.move(to: start)
    ctx.addLine(to: end)
    ctx.strokePath()
}

guard let image = ctx.makeImage() else { fatalError("could not render image") }
let rep = NSBitmapImageRep(cgImage: image)
rep.size = NSSize(width: side, height: side)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("could not encode png") }
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
