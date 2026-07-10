/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  transpilePackages: ["@hahatalk/contracts"],
  typedRoutes: true
};

export default nextConfig;
