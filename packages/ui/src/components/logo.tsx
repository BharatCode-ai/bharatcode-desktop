import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      aria-label="BharatCode mark"
      role="img"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>BharatCode</title>
      <rect data-slot="logo-mark-field" x="1" y="1" width="14" height="18" rx="2" fill="var(--icon-strong-base)" />
      <path
        data-slot="logo-mark-prompt"
        d="M4.25 6.25L6.95 10L4.25 13.75"
        stroke="var(--surface-base)"
        stroke-width="1.6"
        stroke-linecap="square"
        stroke-linejoin="round"
      />
      <path
        data-slot="logo-mark-b"
        d="M8.2 5.75H10.65C11.75 5.75 12.55 6.45 12.55 7.5C12.55 8.38 12.08 8.9 11.35 9.15C12.2 9.38 12.9 10.03 12.9 11.15C12.9 12.45 11.98 13.25 10.7 13.25H8.2V5.75ZM8.2 9.15H10.5M8.2 13.25H10.7"
        stroke="var(--surface-base)"
        stroke-width="1.35"
        stroke-linecap="square"
        stroke-linejoin="round"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      aria-label="BharatCode"
      role="img"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>BharatCode</title>
      <rect x="5" y="5" width="70" height="90" rx="10" fill="var(--icon-strong-base)" />
      <rect x="15" y="16" width="50" height="68" rx="4" fill="var(--icon-base)" opacity="0.28" />
      <path
        d="M22 32L35 50L22 68"
        stroke="var(--surface-base)"
        stroke-width="7"
        stroke-linecap="square"
        stroke-linejoin="round"
      />
      <path
        d="M41 30H53C58.5 30 62 33.4 62 38.5C62 42.6 59.7 45.5 56.4 46.7C60.6 48 64 51.6 64 57C64 63.5 59.5 68 53 68H41V30ZM41 46.7H52.3M41 68H53"
        stroke="var(--surface-base)"
        stroke-width="6"
        stroke-linecap="square"
        stroke-linejoin="round"
      />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      aria-label="BharatCode"
      role="img"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <title>BharatCode</title>
      <g>
        <rect x="0" y="6" width="28" height="30" rx="4" fill="var(--icon-base)" />
        <rect x="5" y="11" width="18" height="20" rx="2" fill="var(--icon-weak-base)" />
        <path
          d="M7.5 15.25L12 21L7.5 26.75"
          stroke="var(--icon-strong-base)"
          stroke-width="2.4"
          stroke-linecap="square"
          stroke-linejoin="round"
        />
        <path
          d="M14.4 14.25H18.5C20.45 14.25 21.75 15.4 21.75 17.15C21.75 18.55 20.95 19.45 19.75 19.9C21.25 20.3 22.4 21.45 22.4 23.25C22.4 25.4 20.9 26.75 18.65 26.75H14.4V14.25ZM14.4 19.9H18.45M14.4 26.75H18.65"
          stroke="var(--icon-strong-base)"
          stroke-width="2.1"
          stroke-linecap="square"
          stroke-linejoin="round"
        />
        <text
          x="42"
          y="28.5"
          fill="var(--icon-strong-base)"
          font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          font-size="20"
          font-weight="760"
          letter-spacing="2"
        >
          BHARATCODE
        </text>
      </g>
    </svg>
  )
}
