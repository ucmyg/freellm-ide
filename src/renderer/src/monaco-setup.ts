import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
// monaco-editor 0.56 exports subpaths as "./*" -> "./esm/vs/*.js", so the
// esm/vs prefix must be left off or resolution doubles it.
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

/**
 * @monaco-editor/react fetches Monaco from a CDN by default. The app's CSP
 * forbids that (and it would break offline), so point it at the bundled copy
 * and wire the language workers through Vite instead.
 */

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  },
}

loader.config({ monaco })

/** Editor theme matched to the app palette rather than Monaco's stock dark. */
export const THEME_NAME = 'freellm-dark'

monaco.editor.defineTheme(THEME_NAME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b7482', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'e8a33d' },
    { token: 'string', foreground: '9ae6b4' },
    { token: 'number', foreground: '5aa9e6' },
    { token: 'type', foreground: '7fd0e0' },
  ],
  colors: {
    'editor.background': '#0e1013',
    'editor.foreground': '#dfe3ea',
    'editorLineNumber.foreground': '#3d4550',
    'editorLineNumber.activeForeground': '#9aa3b0',
    'editor.selectionBackground': '#2a3340',
    'editor.lineHighlightBackground': '#15181d',
    'editorCursor.foreground': '#e8a33d',
    'editorIndentGuide.background1': '#1e232a',
    'editorGutter.background': '#0e1013',
    'editorWidget.background': '#15181d',
    'editorWidget.border': '#262b33',
    'input.background': '#1a1e24',
    'dropdown.background': '#15181d',
    'scrollbarSlider.background': '#2c323b80',
  },
})

export { monaco }
