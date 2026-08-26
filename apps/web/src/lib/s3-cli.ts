import type { S3ConnectionConfig } from "@/api/client";

export interface S3CliCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function baseCommand({ s3Endpoint }: S3ConnectionConfig): string {
  return `aws --profile drives3 --endpoint-url ${shellQuote(s3Endpoint)}`;
}

export function credentialSetupExample(
  config: S3ConnectionConfig,
  credentials: S3CliCredentials,
): string {
  return [
    `aws configure set aws_access_key_id ${shellQuote(credentials.accessKeyId)} --profile drives3`,
    `aws configure set aws_secret_access_key ${shellQuote(credentials.secretAccessKey)} --profile drives3`,
    `aws configure set region ${shellQuote(config.s3Region)} --profile drives3`,
    "",
    `${baseCommand(config)} s3 ls`,
  ].join("\n");
}

export function documentationSetupExample(config: S3ConnectionConfig): string {
  return credentialSetupExample(config, {
    accessKeyId: "ACCESS_KEY_ID_ANDA",
    secretAccessKey: "SECRET_ACCESS_KEY_ANDA",
  });
}

export function credentialFileContent(
  config: S3ConnectionConfig,
  credentials: S3CliCredentials & { label: string; createdAt: string },
): string {
  return [
    "DriveS3 Gateway — S3 access key",
    "================================",
    "",
    `Label             : ${credentials.label}`,
    `Access Key ID     : ${credentials.accessKeyId}`,
    `Secret Access Key : ${credentials.secretAccessKey}`,
    `S3 Endpoint       : ${config.s3Endpoint}`,
    `Region            : ${config.s3Region}`,
    `Dibuat            : ${credentials.createdAt}`,
    "",
    "PENTING: Secret access key ini hanya ditampilkan satu kali dan tidak",
    "dapat dilihat lagi dari dashboard setelah dialog ini ditutup. Simpan",
    "file ini di tempat yang aman.",
    "",
    "Contoh setup AWS CLI:",
    credentialSetupExample(config, credentials),
    "",
  ].join("\n");
}

export function s3CommandExamples(config: S3ConnectionConfig) {
  const aws = baseCommand(config);
  return {
    test: `${aws} s3 ls`,
    upload: `${aws} s3 cp ./file.txt s3://nama-bucket/file.txt`,
    list: `${aws} s3 ls s3://nama-bucket/`,
    download: `${aws} s3 cp s3://nama-bucket/file.txt ./file.txt`,
    remove: `${aws} s3 rm s3://nama-bucket/file.txt`,
  };
}
