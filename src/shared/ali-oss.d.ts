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
    listBuckets(options?: Record<string, unknown>): Promise<{ buckets?: Array<{ name: string; region?: string; creationDate?: string | Date }> }>
    head(objectName: string): Promise<unknown>
    multipartUpload(objectName: string, filePath: string, options?: MultipartOptions): Promise<unknown>
    cancel(): void
    list(query: Record<string, unknown>): Promise<{ objects?: Array<{ name: string; size?: number; lastModified?: string | Date }>; prefixes?: string[]; isTruncated?: boolean; nextMarker?: string }>
    getStream(name: string, options?: Record<string, unknown>): Promise<{ stream: NodeJS.ReadableStream; res?: unknown }>
    delete(name: string, options?: Record<string, unknown>): Promise<{ res: unknown; deleted?: boolean }>
    copy(name: string, sourceName: string, options?: Record<string, unknown>): Promise<{ res: unknown; data?: unknown }>
    signatureUrl(name: string, options?: { expires?: number; method?: string; process?: string; response?: Record<string, unknown> }): string
  }
  const OSS: { new (options: ClientOptions): OSSClient }
  export default OSS
}
