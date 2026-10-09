import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * libSQL 的本機檔案存取是原生模組（每個平台一個預編譯的 .node）。
   * 讓 Node 在執行期直接載入，不要被打包。
   */
  serverExternalPackages: ["@libsql/client", "libsql"],
};

export default nextConfig;
