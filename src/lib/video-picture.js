/**
 * Whether the floating video square should be on screen.
 *
 * HLS and DASH always play through the <video> element, even when the stream
 * is audio only (some radio stations broadcast that way). Showing an empty
 * black square for those is wrong, so radio and audio items start with the
 * square hidden and only get it if the stream turns out to carry a picture.
 * TV and video items show it straight away, exactly as before.
 */

/** Before the stream has reported its size: should the square be shown? */
export function expectsPicture(item) {
  return item?.type !== 'radio' && item?.type !== 'audio';
}

/** True once the media element knows it has a picture to draw. */
export function hasPicture(video) {
  return Number(video?.videoWidth) > 0 && Number(video?.videoHeight) > 0;
}
