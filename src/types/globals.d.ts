declare const __DEV__: boolean;

declare module '*.css';

// Symbol.dispose is part of the TC39 Explicit Resource Management proposal
// (esnext.disposable lib). Declared here so ts-loader picks it up without
// requiring a separate lib target change in the webpack pipeline.
interface SymbolConstructor {
    readonly dispose: unique symbol;
}
