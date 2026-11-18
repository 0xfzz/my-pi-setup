/**
 * One bundled browser runtime for the host app and trusted plugin halves.
 *
 * Plugin modules are imported from blob URLs. A generated document import map
 * maps their bare specifiers to shims beside this bundle, so React, the JSX
 * runtime, the SDK, icons and renderers keep one module instance across
 * every plugin.
 */
export {
  Children,
  Component,
  Fragment,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
export { default as ReactDefault } from "react";
export * from "@pi-web/bridge";
export { jsx, jsxs, Fragment as JSXFragment } from "react/jsx-runtime";
export * as ReactDOM from "react-dom";
export {
  createPortal,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
  unstable_batchedUpdates,
  useFormState,
  useFormStatus,
  version,
} from "react-dom";
export { createRoot, hydrateRoot } from "react-dom/client";
export * from "@phosphor-icons/react";
export { default as FileViewerDefault, FileViewer, useFileViewerState } from "@file-viewer/react";
export { setDefaultFileViewerAssetBaseUrl } from "@file-viewer/core";
export { default as officePresetDefault } from "@file-viewer/preset-office";
