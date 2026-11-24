import { cpp as cppLang } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html as htmlLang } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown as markdownLang, markdownLanguage } from '@codemirror/lang-markdown';
import { InlineContext, type InlineParser } from '@lezer/markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import type { Extension } from '@codemirror/state';

// The languages the editor plugin reads, kept the same so a file is highlighted alike in the diff and in the editor.
const ts = () => javascript({ typescript: true });
const js = javascript;
const sh = () => StreamLanguage.define(shell);
// CommonMark reads CJK brackets and fullwidth stops as punctuation, which denies a closing ** its right flank when a CJK
// letter follows it, leaving the stars raw. Read those marks as ordinary characters so CJK bold still closes.
const flankPunctuation = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0;
  const cjk = (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef);
  return !cjk && /[\p{S}\p{P}]/u.test(ch);
};
const cjkEmphasis: InlineParser = {
  name: 'Emphasis',
  parse(cx, next, start) {
    if (next !== 42 && next !== 95) return -1;
    let pos = start + 1;
    while (cx.char(pos) === next) pos++;
    const before = cx.slice(start - 1, start), after = cx.slice(pos, pos + 1);
    const pBefore = flankPunctuation(before), pAfter = flankPunctuation(after);
    const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
    const left = !sAfter && (!pAfter || sBefore || pBefore);
    const right = !sBefore && (!pBefore || sAfter || pAfter);
    const open = left && (next === 42 || !right || pBefore);
    const close = right && (next === 42 || !left || pAfter);
    return cx.addDelimiter(next === 95 ? InlineContext.emphasisUnderscore : InlineContext.emphasisAsterisk, start, pos, open, close);
  },
};
const md = () => markdownLang({ base: markdownLanguage, extensions: { parseInline: [cjkEmphasis] } });

// What a file is read as, by the extension it carries or by its whole name when it has none.
const modes: Record<string, () => Extension> = {
  ts, mts: ts, cts: ts,
  js, mjs: js, cjs: js,
  tsx: () => javascript({ typescript: true, jsx: true }),
  jsx: () => javascript({ jsx: true }),
  json, md, markdown: md,
  html: htmlLang, htm: htmlLang, css,
  py: python, rs: rust, java,
  c: cppLang, h: cppLang, cc: cppLang, cpp: cppLang, cxx: cppLang, hpp: cppLang, hh: cppLang,
  go, yaml: yamlLang, yml: yamlLang,
  sh, bash: sh, zsh: sh,
  '.bashrc': sh, '.zshrc': sh, '.profile': sh,
};

// The highlighting of a file: a file this plugin does not read as a language is shown as plain text.
export const modeFor = (path: string): Extension => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return (modes[name] ?? modes[name.slice(name.lastIndexOf('.') + 1).toLowerCase()])?.() ?? [];
};
