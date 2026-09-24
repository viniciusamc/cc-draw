const KIND = {
  rect: 'Rectangle',
  diamond: 'Diamond',
  ellipse: 'Ellipse',
  loop: 'Freehand outline',
  line: 'Underline/strike',
  scribble: 'Freehand scribble',
  arrow: 'Arrow',
  text: 'Standalone note',
  group: 'Group of drawings',
  image: 'Pasted image',
  frame: 'Frame (marked area)',
  picked: 'Selected element',
};

const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';

function element(d, indent = '') {
  if (!d) return 'no element detected';
  const out = [`${code(d.selector)} (${d.size}px)`];
  const sub = indent + '    - ';
  if (d.html) out.push(`${sub}HTML: ${code(d.html)}`);
  if (d.text) out.push(`${sub}Text: "${d.text}"`);
  const styles = Object.entries(d.styles || {}).map(([k, v]) => `${k}: ${v}`).join('; ');
  if (styles) out.push(`${sub}Styles: ${styles}`);
  if (d.source) out.push(`${sub}Likely source: ${d.source}`);
  return out.join('\n');
}

export function buildPrompt(fb, { imageFiles = [] } = {}) {
  const page = fb.page || {};
  const annotations = fb.annotations || [];
  const L = [];

  L.push('# Design feedback (cc-draw)', '');
  L.push(`Page: **${page.title || '(untitled)'}** — ${page.url || '?'}`);
  if (page.viewport) L.push(`Viewport: ${page.viewport.w}×${page.viewport.h}px`);
  if (page.region) {
    const r = page.region;
    L.push(`The images are a crop of the document at x=${r.x}, y=${r.y}, ${r.w}×${r.h}px.`);
  }
  if (imageFiles.length) {
    L.push(imageFiles.length > 1
      ? 'Image 1 = the page as it is; image 2 = the same area with my annotations on top (the numbers match the list below).'
      : 'The image shows my annotations (the numbers match the list below).');
    L.push(`Copies saved at: ${imageFiles.join(', ')}`);
  }
  if (fb.captureError) L.push(`(Image capture partly failed — the images may be incomplete; trust the list below. Error: ${fb.captureError})`);

  if (fb.notes) L.push('', '## General request', '', fb.notes);

  if (annotations.length) {
    L.push('', '## Annotations', '');
    if (annotations.some((a) => a.comment)) {
      L.push('In each annotation, the **Instruction** is what I want there — treat it as the main request. **Notes** are texts I wrote on the drawing itself.', '');
    }
    const quote = (s) => `"${String(s).replace(/\n/g, '\n  ')}"`;
    for (const a of annotations) {
      L.push(`### #${a.n} — ${KIND[a.kind] || a.kind} (${a.color})`);
      if (a.comment) L.push(`- Instruction: ${quote(a.comment)}`);
      if (a.notes?.length) for (const n of a.notes) L.push(`- Note: ${quote(n)}`);
      else if (!a.comment) L.push('- (no text — interpret the drawing)');
      if (a.kind === 'arrow') {
        L.push(a.fromAnnotation ? `- Starts at annotation #${a.fromAnnotation}` : `- Starts at: ${element(a.from)}`);
        L.push(a.toAnnotation ? `- Points to annotation #${a.toAnnotation}` : `- Points to: ${element(a.to)}`);
      } else if (a.kind === 'picked' && !a.selectorMissing) {
        L.push(`- I selected exactly this element (with the element picker): ${element(a.target)}`);
      } else {
        if (a.kind === 'picked') {
          L.push(`- I selected the element ${code(a.selector || '?')}, but it no longer exists on the page; this is what is in the marked area:`);
        }
        if (a.targets?.length) {
          const n = a.targets.length;
          L.push(`- The mark covers ${n} ${n === 1 ? 'element' : 'elements'}:`);
          for (const t of a.targets) L.push(`  - ${element(t, '  ')}`);
        } else {
          L.push(`- ${a.kind === 'text' ? 'Written on top of' : 'Marked element'}: ${element(a.target)}`);
        }
      }
      const b = a.bbox;
      if (b) L.push(`- Drawing position: x=${b.x}, y=${b.y}, ${b.w}×${b.h}px (document coordinates)`);
      L.push('');
    }
  }

  L.push("Apply these changes to this project's source code.");
  if (annotations.length) {
    L.push('', 'I watch your progress live on the page: call `report_progress` with `working` right before you start each annotation and with `done` right after you finish it, one annotation at a time.');
  }
  return L.join('\n');
}
