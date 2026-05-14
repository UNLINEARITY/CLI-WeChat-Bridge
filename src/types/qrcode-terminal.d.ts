declare module "qrcode-terminal" {
  type GenerateOptions = {
    small?: boolean;
  };

  const qrcodeTerminal: {
    generate(
      input: string,
      options?: GenerateOptions,
      callback?: (qrcode: string) => void,
    ): void;
  };

  export default qrcodeTerminal;
}
