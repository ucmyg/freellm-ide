/// <reference types="vite/client" />

import type { IdeApi } from '../preload/index'

declare global {
  interface Window {
    ide: IdeApi
  }
}

export {}
