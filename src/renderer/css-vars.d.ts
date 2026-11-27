// Lets `style` take CSS variables, as a theme tile's colors are.
import 'react';

declare module 'react' {
  interface CSSProperties {
    [variable: `--${string}`]: string | undefined;
  }
}
