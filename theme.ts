import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { Theme } from '@lengmoxxl/sdk';
import type { Font } from './shared';

// The colours the editor plugin reads its text in, kept token for token so a file looks the same in the diff as in the
// editor; the diff adds its own tints for the lines and words a change touches. Built again on a switch of theme.
export function editorTheme(theme: Theme, font: Font) {
  const dark = getComputedStyle(document.documentElement).colorScheme !== 'light';
  const alpha = (color: string, value: number) => `${color}${Math.round(value * 255).toString(16).padStart(2, '0')}`;
  const lineHeight = font.lineHeight ? Math.round(font.size * font.lineHeight) : 0;
  const shell = EditorView.theme({
    '&': { height: '100%', color: theme.foreground, backgroundColor: theme.background, fontSize: `${font.size}px` },
    '.cm-scroller': lineHeight ? { fontFamily: font.family, lineHeight: `${lineHeight}px` } : { fontFamily: font.family },
    '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: theme.selection },
    '.cm-gutters': { backgroundColor: theme.background, color: theme.muted, border: 'none' },
    // The caret as the block vim draws, in the editor's cursor colour.
    '.cm-cursor, .cm-dropCursor': { borderLeft: 'none', width: '0.6em', backgroundColor: theme.cursor },
    '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
    '.cm-scroller::-webkit-scrollbar-thumb': { backgroundColor: theme.muted, borderRadius: '5px' },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': { backgroundColor: theme.foreground },
    '.cm-scroller::-webkit-scrollbar-corner': { backgroundColor: 'transparent' },
    // The change tints: a touched line carries a faint wash, the changed words a stronger one, on the side's own hue.
    '&.cm-merge-a .cm-changedLine': { backgroundColor: alpha(theme.red, 0.08) },
    '&.cm-merge-b .cm-changedLine, & .cm-inlineChangedLine': { backgroundColor: alpha(theme.green, 0.08) },
    '&.cm-merge-a .cm-changedText': { background: alpha(theme.red, 0.2) },
    '&.cm-merge-b .cm-changedText': { background: alpha(theme.green, 0.2) },
    '& .cm-deletedChunk': { backgroundColor: alpha(theme.red, 0.08) },
    '&.cm-merge-b .cm-deletedText, &.cm-editor .cm-deletedChunk .cm-deletedText': { background: alpha(theme.red, 0.2) },
  }, { dark });
  const tokens = HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: theme.muted },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: theme.green },
    { tag: [tags.number, tags.bool, tags.null], color: theme.yellow },
    { tag: tags.atom, color: theme.blue },
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: theme.magenta },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: theme.cyan },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: theme.blue },
    { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName), tags.self], color: theme.brightMagenta },
    { tag: tags.heading, color: theme.blue, fontWeight: '600' },
    { tag: tags.strong, fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: [tags.link, tags.url], color: theme.cyan, textDecoration: 'underline' },
  ]);
  return [shell, syntaxHighlighting(tokens)];
}
