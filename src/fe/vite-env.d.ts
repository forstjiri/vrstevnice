declare module '*.css' {
  const content: string;
  export default content;
}

declare module '*.svg?url' {
  const url: string;
  export default url;
}

declare module '*.png?url' {
  const url: string;
  export default url;
}
