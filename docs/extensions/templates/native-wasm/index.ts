import photon from "@silvia-odwyer/photon-node";

const { PhotonImage } = photon;

export async function activate() {
  return {
    async dimensions(pngBytes) {
      const image = PhotonImage.new_from_byteslice(pngBytes);
      try {
        return { width: image.get_width(), height: image.get_height() };
      } finally {
        image.free();
      }
    },
  };
}
