// Image imports (`import x from '….webp'`) are typed by Next's image declarations. They usually
// arrive through next-env.d.ts, which Next generates and git ignores, so CI's typecheck (it runs
// before `next build`) had no type for demo/shims/marketing-media-src.ts. Reference the same
// declarations here; the reference is de-duplicated when next-env.d.ts exists too.
/// <reference types="next/image-types/global" />
