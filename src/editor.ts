import { minimalSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";

// Quiet highlighting: structure through weight and slant, not colour.
const quietHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "bold" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.quote, fontStyle: "italic" },
  { tag: [tags.link, tags.url, tags.processingInstruction, tags.monospace, tags.meta], color: "var(--muted)" },
]);

export interface EditorCallbacks {
  onChange: (text: string) => void;
  /** Images pasted or dropped; `pos` is where the links should go. */
  onImages: (files: File[], pos: number) => void;
}

function imageFiles(list: FileList | undefined | null): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
}

export function createEditor(parent: HTMLElement, callbacks: EditorCallbacks) {
  const extensions = [
    minimalSetup,
    markdown(),
    syntaxHighlighting(quietHighlight),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on" }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) callbacks.onChange(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = imageFiles(event.clipboardData?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        callbacks.onImages(files, view.state.selection.main.head);
        return true;
      },
      drop(event, view) {
        const files = imageFiles(event.dataTransfer?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
        callbacks.onImages(files, pos);
        return true;
      },
    }),
  ];

  const view = new EditorView({ parent });

  return {
    /** Replaces the document (and its undo history) with a new note. */
    load(text: string) {
      view.setState(EditorState.create({ doc: text, extensions }));
    },
    insert(text: string, pos: number) {
      view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
    },
    focus() {
      view.focus();
    },
  };
}
