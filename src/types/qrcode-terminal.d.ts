// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
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
