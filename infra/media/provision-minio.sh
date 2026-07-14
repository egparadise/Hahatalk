#!/bin/sh
set -eu

alias_name="hahatalk"
bucket_path="${alias_name}/${RECORDING_BUCKET}"

mc alias set "${alias_name}" http://minio:9000 "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" --api S3v4 --path on
mc mb --ignore-existing "${bucket_path}"
mc anonymous set none "${bucket_path}"
mc admin policy create "${alias_name}" hahatalk-egress-write /policies/egress-write-policy.json
mc admin user add "${alias_name}" "${LIVEKIT_EGRESS_S3_ACCESS_KEY}" "${LIVEKIT_EGRESS_S3_SECRET_KEY}"
mc admin policy attach "${alias_name}" hahatalk-egress-write --user "${LIVEKIT_EGRESS_S3_ACCESS_KEY}"
mc ilm rule add --expire-days "${RECORDING_RETENTION_DAYS}" --prefix recordings/ "${bucket_path}"

mc anonymous get "${bucket_path}"
mc admin user info "${alias_name}" "${LIVEKIT_EGRESS_S3_ACCESS_KEY}"
mc ilm rule ls "${bucket_path}"
