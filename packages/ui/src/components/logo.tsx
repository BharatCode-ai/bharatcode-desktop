import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      aria-label="BharatCode mark"
      role="img"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>BharatCode</title>
      <g fill="none" stroke="#ff6b35" stroke-width="54" stroke-linecap="square" stroke-linejoin="miter">
        <path data-slot="logo-mark-left" d="M194 142 84 256l110 114" />
        <path data-slot="logo-mark-right" d="m318 142 110 114-110 114" />
      </g>
      <path data-slot="logo-mark-node" fill="#ff6b35" d="m256 221 35 35-35 35-35-35z" />
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
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>BharatCode</title>
      <g fill="none" stroke="#ff6b35" stroke-width="54" stroke-linecap="square" stroke-linejoin="miter">
        <path d="M194 142 84 256l110 114" />
        <path d="m318 142 110 114-110 114" />
      </g>
      <path fill="#ff6b35" d="m256 221 35 35-35 35-35-35z" />
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
      <g transform="translate(0 5) scale(.0625)">
        <g fill="none" stroke="#ff6b35" stroke-width="54" stroke-linecap="square" stroke-linejoin="miter">
          <path d="M194 142 84 256l110 114" />
          <path d="m318 142 110 114-110 114" />
        </g>
        <path fill="#ff6b35" d="m256 221 35 35-35 35-35-35z" />
      </g>
      <g>
        <text
          x="42"
          y="28.5"
          fill="var(--icon-strong-base)"
          font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          font-size="20"
          font-weight="700"
          letter-spacing="0"
        >
          BharatCode
        </text>
      </g>
    </svg>
  )
}
