export {};

declare global {
  interface Window {
    normie: {
      ready(info: { rows: number }): void;
      platform: string;
    };
  }
}
