/** File patterns for `r2-lfs init --track <preset>`. */
export const PRESETS: Record<string, string[]> = {
  blender: [
    "*.blend",
    "*.fbx",
    "*.obj",
    "*.glb",
    "*.abc",
    "*.usd",
    "*.usdc",
    "*.usdz",
    "*.vrm",
    "*.exr",
    "*.hdr",
    "*.png",
    "*.jpg",
    "*.tga",
    "*.tif",
  ],
  images: ["*.png", "*.jpg", "*.jpeg", "*.tga", "*.tif", "*.tiff", "*.psd", "*.kra", "*.exr", "*.hdr", "*.webp"],
  video: ["*.mp4", "*.mov", "*.mkv", "*.webm", "*.avi"],
  audio: ["*.wav", "*.mp3", "*.flac", "*.ogg", "*.aif", "*.aiff"],
  unity: ["*.fbx", "*.psd", "*.tga", "*.png", "*.exr", "*.wav", "*.mp3", "*.cubemap", "*.unitypackage"],
  unreal: ["*.uasset", "*.umap", "*.upk", "*.fbx", "*.wav"],
  archives: ["*.zip", "*.7z", "*.rar", "*.tar.gz"],
};

/** Expands preset names and passes literal patterns through, without duplicates. */
export function expandTracks(values: string[]): string[] {
  const patterns = new Set<string>();
  for (const value of values.flatMap((v) => v.split(","))) {
    const name = value.trim();
    if (!name) continue;
    for (const pattern of PRESETS[name] ?? [name]) patterns.add(pattern);
  }
  return [...patterns];
}
