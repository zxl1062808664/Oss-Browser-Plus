declare module 'ali-oss' {
  interface ClientOptions {
    accessKeyId: string
    accessKeySecret: string
    region?: string
    endpoint?: string
    bucket?: string
    secure?: boolean
    timeout?: number
  }
  interface MultipartOptions {
    parallel?: number
    partSize?: number
    progress?: (percentage: number, checkpoint?: unknown, res?: unknown) => Promise<void> | void
  }
  interface OSSClient {
    listBuckets(options?: Record<string, unknown>): Promise<unknown>
    head(objectName: string): Promise<unknown>
    multipartUpload(objectName: string, filePath: string, options?: MultipartOptions): Promise<unknown>
  }
  const OSS: { new (options: ClientOptions): OSSClient }
  export default OSS
}
