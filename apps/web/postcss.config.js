import { fileURLToPath } from "node:url";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";

const tailwindConfig = fileURLToPath(new URL("./tailwind.config.ts", import.meta.url));

export default {
  plugins: [tailwindcss({ config: tailwindConfig }), autoprefixer()],
};
