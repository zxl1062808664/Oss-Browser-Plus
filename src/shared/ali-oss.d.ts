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
    head(objectName: string): Promise<{ res?: { headers?: Record<string, unknown> } }>
    get(name: string, options?: Record<string, unknown>): Promise<{ content: Buffer; res?: unknown }>
    put(objectName: string, content: Buffer | Uint8Array | string, options?: Record<string, unknown>): Promise<{ res?: { headers?: Record<string, unknown> } }>
    multipartUpload(objectName: string, filePath: string, options?: MultipartOptions): Promise<unknown>
    cancel(): void
    list(query: Record<string, unknown>): Promise<{ objects?: Array<{ name: string; size?: number; lastModified?: string | Date }>; prefixes?: string[]; isTruncated?: boolean; nextMarker?: string }>
    getStream(name: string, options?: Record<string, unknown>): Promise<{ stream: NodeJS.ReadableStream; res?: unknown }>
    delete(name: string, options?: Record<string, unknown>): Promise<{ res: unknown; deleted?: boolean }>
    copy(name: string, sourceName: string, options?: Record<string, unknown>): Promise<{ res: unknown; data?: unknown }>
    signatureUrl(name: string, options?: { expires?: number; method?: string; process?: string; response?: Record<string, unknown> }): string
    /**
     * 批量删除（单次最多 1000 个）。
     * deleted 是「成功删除」的对象列表（来自响应 XML 的 <Deleted> 节点），
     * 因此不要传 quiet:true —— quiet 下 OSS 只返回失败的 <Error>，deleted 会是空数组。
     */
    deleteMulti(names: string[], options?: Record<string, unknown>): Promise<{ res: unknown; deleted?: Array<{ Key?: string }> }>
  }
  const OSS: { new (options: ClientOptions): OSSClient }
  export default OSS
}
