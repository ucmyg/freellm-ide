import { useCallback, useEffect, useRef } from 'react'

interface Props {
  orientation: 'vertical' | 'horizontal'
  /** Called with the pointer delta in px since the drag started. */
  onResize(deltaPx: number): void
}

/**
 * A 4px drag handle. Pointer capture keeps the drag alive even when the cursor
 * outruns the handle, which is easy to do on a thin target.
 */
export default function Resizer({ orientation, onResize }: Props) {
  const start = useRef<number | null>(null)
  const isVertical = orientation === 'vertical'

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      start.current = isVertical ? e.clientX : e.clientY
    },
    [isVertical],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (start.current === null) return
      const current = isVertical ? e.clientX : e.clientY
      onResize(current - start.current)
      start.current = current
    },
    [isVertical, onResize],
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    start.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])

  // A drag that leaves the window should not leave the layout stuck mid-resize.
  useEffect(() => {
    const cancel = () => {
      start.current = null
    }
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  }, [])

  return (
    <div
      role="separator"
      aria-orientation={isVertical ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={
        isVertical
          ? 'w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-[var(--color-accent-dim)] transition-colors'
          : 'h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-[var(--color-accent-dim)] transition-colors'
      }
    />
  )
}
