# ClusterFuzzLite build image, on the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets. The base is pinned by digest;
# OSS-Fuzz rolls this image, so bump the digest if the build breaks.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:fff2fe5f532ffcd3fcea7c54cc1db18951b364b64aa37c415348ce8ba17cde34
COPY . $SRC/pitlane
WORKDIR $SRC/pitlane
COPY .clusterfuzzlite/build.sh $SRC/build.sh
