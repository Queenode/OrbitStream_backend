import { IsString, IsNotEmpty, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class RequestChallengeDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^G[A-Z0-9]{55}$/, { message: 'Must be a valid Stellar public key (starts with G, 56 chars)' })
  walletAddress: string;
}

export class VerifyChallengeDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^G[A-Z0-9]{55}$/, { message: 'Must be a valid Stellar public key (starts with G, 56 chars)' })
  walletAddress: string;

  @ValidateNested()
  @Type(() => SignedTransactionDto)
  @IsNotEmpty()
  transaction: SignedTransactionDto;
}

export class SignedTransactionDto {
  @IsString()
  @IsNotEmpty()
  tx: string;

  @IsString()
  @IsNotEmpty()
  passphrase: string;
}

export class WalletLoginDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^G[A-Z0-9]{55}$/, { message: 'Must be a valid Stellar public key (starts with G, 56 chars)' })
  walletAddress: string;
}
