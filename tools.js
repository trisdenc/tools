// Add, remove or edit your tools here. Each tool needs a name, url and category.
// description, tags, icon (an emoji) and image (a path to an icon file) are optional;
// without either, the site's favicon is used.
// Relative urls like "timezone/" point to tools built in this repo.
const TOOLS = [
  { name: "Time Zone Finder", url: "timezone/", category: "My Tools", icon: "🕒", description: "Convert a time in another zone to your local time.", tags: ["time", "timezone", "convert"] },
  { name: "Unit Converter", url: "units/", category: "My Tools", icon: "📏", description: "Length, weight, volume, temperature, data and more. Type \"5 ft to cm\".", tags: ["convert", "metric", "imperial", "bytes", "measurement"] },
  { name: "WebP Converter", url: "webp/", category: "My Tools", icon: "🖼️", description: "Convert any image to optimized WebP for websites. Runs in your browser.", tags: ["image", "webp", "compress", "optimize", "png", "jpg"] },
  { name: "HiROM Studio", url: "hirom/", category: "HiROM Studio", image: "hirom/brand/mark.svg", description: "Home of the HiROM Studio apps for making SNES music and games.", tags: ["snes", "hirom", "suite"] },
  { name: "HiROM Sound", url: "hirom/sound/", category: "HiROM Studio", image: "hirom/brand/sound.svg", description: "Compose SNES music and sound effects with an accurate S-DSP engine.", tags: ["music", "audio", "snes", "chiptune", "sfx", "tracker", "brr", "hirom"] },
  { name: "HiROM Pixel", url: "hirom/pixel/", category: "HiROM Studio", image: "hirom/brand/pixel.svg", description: "Draw SNES sprites, tiles and scenes with real S-PPU palette and VRAM limits.", tags: ["pixel", "art", "sprite", "tiles", "palette", "snes", "hirom"] },
  { name: "GitHub", url: "https://github.com", category: "Development", description: "Code hosting and collaboration.", tags: ["git", "code"] },
  { name: "Regex101", url: "https://regex101.com", category: "Development", description: "Build and test regular expressions.", tags: ["regex"] },
  { name: "JSON Formatter", url: "https://jsonformatter.org", category: "Development", description: "Format and validate JSON.", tags: ["json"] },
  { name: "Can I Use", url: "https://caniuse.com", category: "Development", description: "Browser support tables for web features.", tags: ["web", "css"] },
  { name: "Excalidraw", url: "https://excalidraw.com", category: "Design", description: "Hand-drawn style whiteboard and diagrams.", tags: ["diagram"] },
  { name: "Coolors", url: "https://coolors.co", category: "Design", description: "Color palette generator.", tags: ["color"] },
  { name: "TinyPNG", url: "https://tinypng.com", category: "Utilities", description: "Compress PNG and JPEG images.", tags: ["images"] },
  { name: "Time Zone Converter", url: "https://www.timeanddate.com/worldclock/converter.html", category: "Utilities", description: "Compare times across time zones.", tags: ["time"] },
];
