export async function activate(ctx) {
  return {
    async ping(value) {
      ctx.log.info("ping", { value });
      return `pong:${value}`;
    },
  };
}
