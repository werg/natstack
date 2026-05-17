import cjsPackage from "some-commonjs-package";

const { usefulFunction } = cjsPackage;

export async function activate() {
  return {
    async run(value) {
      return usefulFunction(value);
    },
  };
}
