// Replaces @excalidraw/mermaid-to-excalidraw (and all of mermaid, ~8 MB) in the canvas bundle.
// cc-draw doesn't use "Mermaid / Text to diagram"; its UI is hidden. If some path still calls it
// (e.g. pasting text that looks like mermaid), Excalidraw catches the error and pastes it as plain text.
export const parseMermaidToExcalidraw = async () => {
  throw new Error('mermaid is disabled in cc-draw');
};
export default { parseMermaidToExcalidraw };
