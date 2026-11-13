/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" only in the evaluation build (npm run build:clean): the unsafe clean-screens baseline. */
  readonly VITE_EVAL_CLEAN?: string;
}
