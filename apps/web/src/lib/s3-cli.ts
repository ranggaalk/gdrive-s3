import type { S3ConnectionConfig } from "@/api/client";

export interface S3CliCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface CredentialFileLabels {
  heading: string;
  label: string;
  accessKeyId: string;
  secretAccessKey: string;
  s3Endpoint: string;
  region: string;
  createdAt: string;
  warningLines: string[];
  cliExampleHeading: string;
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

export function documentationSetupExample(
  config: S3ConnectionConfig,
  placeholders: S3CliCredentials,
): string {
  return credentialSetupExample(config, placeholders);
}

export function credentialFileContent(
  config: S3ConnectionConfig,
  credentials: S3CliCredentials & { label: string; createdAt: string },
  labels: CredentialFileLabels,
): string {
  const fields: Array<[string, string]> = [
    [labels.label, credentials.label],
    [labels.accessKeyId, credentials.accessKeyId],
    [labels.secretAccessKey, credentials.secretAccessKey],
    [labels.s3Endpoint, config.s3Endpoint],
    [labels.region, config.s3Region],
    [labels.createdAt, credentials.createdAt],
  ];
  const width = Math.max(...fields.map(([field]) => field.length));
  return [
    labels.heading,
    "=".repeat(labels.heading.length),
    "",
    ...fields.map(([field, value]) => `${field.padEnd(width)} : ${value}`),
    "",
    ...labels.warningLines,
    "",
    labels.cliExampleHeading,
    credentialSetupExample(config, credentials),
    "",
  ].join("\n");
}

export function s3CommandExamples(config: S3ConnectionConfig, bucketName: string) {
  const aws = baseCommand(config);
  return {
    test: `${aws} s3 ls`,
    upload: `${aws} s3 cp ./file.txt s3://${bucketName}/file.txt`,
    list: `${aws} s3 ls s3://${bucketName}/`,
    download: `${aws} s3 cp s3://${bucketName}/file.txt ./file.txt`,
    remove: `${aws} s3 rm s3://${bucketName}/file.txt`,
  };
}
