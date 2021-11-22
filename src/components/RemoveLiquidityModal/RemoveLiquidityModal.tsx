import React, { useState, useMemo, useCallback } from 'react';
import { splitSignature } from '@ethersproject/bytes';
import { Contract } from '@ethersproject/contracts';
import { ArrowLeft, ArrowDown } from 'react-feather';
import { Box, Typography, Button } from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import { Currency, ETHER, JSBI, Percent } from '@uniswap/sdk';
import ReactGA from 'react-ga';
import { BigNumber } from '@ethersproject/bignumber';
import { TransactionResponse } from '@ethersproject/providers';
import { ROUTER_ADDRESS } from 'constants/index';
import {
  CustomModal,
  DoubleCurrencyLogo,
  ColoredSlider,
  CurrencyLogo,
  TransactionConfirmationModal,
  TransactionErrorContent,
  ConfirmationModalContent,
} from 'components';
import {
  useDerivedBurnInfo,
  useBurnState,
  useBurnActionHandlers,
} from 'state/burn/hooks';
import { Field } from 'state/burn/actions';
import { useUserSlippageTolerance } from 'state/user/hooks';
import {
  useTransactionAdder,
  useTransactionFinalizer,
} from 'state/transactions/hooks';
import { useTokenBalance } from 'state/wallet/hooks';
import { useActiveWeb3React, useIsArgentWallet } from 'hooks';
import { usePairContract } from 'hooks/useContract';
import {
  calculateGasMargin,
  calculateSlippageAmount,
  getRouterContract,
} from 'utils';
import useDebouncedChangeHandler from 'utils/useDebouncedChangeHandler';
import useTransactionDeadline from 'hooks/useTransactionDeadline';
import { useApproveCallback, ApprovalState } from 'hooks/useApproveCallback';
import { wrappedCurrency } from 'utils/wrappedCurrency';
import { useTotalSupply } from 'data/TotalSupply';
import { ReactComponent as CloseIcon } from 'assets/images/CloseIcon.svg';

const useStyles = makeStyles(({}) => ({
  input: {
    width: '100%',
    background: 'transparent',
    border: 'none',
    boxShadow: 'none',
    outline: 'none',
    color: '#c7cad9',
    fontSize: 28,
    fontWeight: 600,
  },
  removeButton: {
    backgroundImage:
      'linear-gradient(104deg, #004ce6 -32%, #0098ff 54%, #00cff3 120%, #64fbd3 198%)',
    backgroundColor: 'transparent',
    height: 48,
    width: '48%',
    borderRadius: 10,
    '& span': {
      fontSize: 16,
      fontWeight: 600,
    },
    '&.Mui-disabled': {
      backgroundImage: 'none',
      backgroundColor: '#282d3d',
    },
  },
}));

interface RemoveLiquidityModalProps {
  currency0: Currency;
  currency1: Currency;
  open: boolean;
  onClose: () => void;
}

const RemoveLiquidityModal: React.FC<RemoveLiquidityModalProps> = ({
  currency0,
  currency1,
  open,
  onClose,
}) => {
  const classes = useStyles();
  const [showConfirm, setShowConfirm] = useState(false);
  const [txPending, setTxPending] = useState(false);
  const [attemptingTxn, setAttemptingTxn] = useState(false);
  const [removeErrorMessage, setRemoveErrorMessage] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [txHash, setTxHash] = useState('');
  const addTransaction = useTransactionAdder();
  const finalizedTransaction = useTransactionFinalizer();
  const { chainId, account, library } = useActiveWeb3React();
  const [tokenA, tokenB] = useMemo(
    () => [
      wrappedCurrency(currency0, chainId),
      wrappedCurrency(currency1, chainId),
    ],
    [currency0, currency1, chainId],
  );

  const { independentField, typedValue } = useBurnState();
  const { pair, parsedAmounts, error } = useDerivedBurnInfo(
    currency0,
    currency1,
  );
  const deadline = useTransactionDeadline();
  const { onUserInput: _onUserInput } = useBurnActionHandlers();
  const [allowedSlippage] = useUserSlippageTolerance();

  const onUserInput = useCallback(
    (field: Field, typedValue: string) => {
      setSignatureData(null);
      return _onUserInput(field, typedValue);
    },
    [_onUserInput],
  );

  const onLiquidityInput = useCallback(
    (typedValue: string): void => onUserInput(Field.LIQUIDITY, typedValue),
    [onUserInput],
  );

  const liquidityPercentChangeCallback = useCallback(
    (value: number) => {
      onUserInput(Field.LIQUIDITY_PERCENT, value.toString());
    },
    [onUserInput],
  );

  const [
    innerLiquidityPercentage,
    setInnerLiquidityPercentage,
  ] = useDebouncedChangeHandler(
    Number.parseInt(parsedAmounts[Field.LIQUIDITY_PERCENT].toFixed(0)),
    liquidityPercentChangeCallback,
  );
  const userPoolBalance = useTokenBalance(
    account ?? undefined,
    pair?.liquidityToken,
  );
  const totalPoolTokens = useTotalSupply(pair?.liquidityToken);
  const poolTokenPercentage =
    !!userPoolBalance &&
    !!totalPoolTokens &&
    JSBI.greaterThanOrEqual(totalPoolTokens.raw, userPoolBalance.raw)
      ? new Percent(userPoolBalance.raw, totalPoolTokens.raw)
      : undefined;

  const formattedAmounts = {
    [Field.LIQUIDITY_PERCENT]: parsedAmounts[Field.LIQUIDITY_PERCENT].equalTo(
      '0',
    )
      ? '0'
      : parsedAmounts[Field.LIQUIDITY_PERCENT].lessThan(new Percent('1', '100'))
      ? '<1'
      : parsedAmounts[Field.LIQUIDITY_PERCENT].toFixed(0),
    [Field.LIQUIDITY]:
      independentField === Field.LIQUIDITY
        ? typedValue
        : parsedAmounts[Field.LIQUIDITY]?.toSignificant(6) ?? '',
    [Field.CURRENCY_A]:
      independentField === Field.CURRENCY_A
        ? typedValue
        : parsedAmounts[Field.CURRENCY_A]?.toSignificant(6) ?? '',
    [Field.CURRENCY_B]:
      independentField === Field.CURRENCY_B
        ? typedValue
        : parsedAmounts[Field.CURRENCY_B]?.toSignificant(6) ?? '',
  };

  const [token0Deposited, token1Deposited] =
    !!pair &&
    !!totalPoolTokens &&
    !!userPoolBalance &&
    JSBI.greaterThanOrEqual(totalPoolTokens.raw, userPoolBalance.raw)
      ? [
          pair.getLiquidityValue(
            pair.token0,
            totalPoolTokens,
            userPoolBalance,
            false,
          ),
          pair.getLiquidityValue(
            pair.token1,
            totalPoolTokens,
            userPoolBalance,
            false,
          ),
        ]
      : [undefined, undefined];

  const pairContract: Contract | null = usePairContract(
    pair?.liquidityToken?.address,
  );
  const [signatureData, setSignatureData] = useState<{
    v: number;
    r: string;
    s: string;
    deadline: number;
  } | null>(null);
  const [approval, approveCallback] = useApproveCallback(
    parsedAmounts[Field.LIQUIDITY],
    ROUTER_ADDRESS,
  );
  const isArgentWallet = useIsArgentWallet();

  const onAttemptToApprove = async () => {
    if (!pairContract || !pair || !library || !deadline) {
      setErrorMsg('missing dependencies');
      return;
    }
    const liquidityAmount = parsedAmounts[Field.LIQUIDITY];
    if (!liquidityAmount) {
      setErrorMsg('missing liquidity amount');
      return;
    }

    if (isArgentWallet) {
      return approveCallback();
    }

    // try to gather a signature for permission
    const nonce = await pairContract.nonces(account);

    const EIP712Domain = [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ];
    const domain = {
      name: 'Uniswap V2',
      version: '1',
      chainId: chainId,
      verifyingContract: pair.liquidityToken.address,
    };
    const Permit = [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ];
    const message = {
      owner: account,
      spender: ROUTER_ADDRESS,
      value: liquidityAmount.raw.toString(),
      nonce: nonce.toHexString(),
      deadline: deadline.toNumber(),
    };
    const data = JSON.stringify({
      types: {
        EIP712Domain,
        Permit,
      },
      domain,
      primaryType: 'Permit',
      message,
    });

    library
      .send('eth_signTypedData_v4', [account, data])
      .then(splitSignature)
      .then((signature) => {
        setSignatureData({
          v: signature.v,
          r: signature.r,
          s: signature.s,
          deadline: deadline.toNumber(),
        });
      })
      .catch((error) => {
        // for all errors other than 4001 (EIP-1193 user rejected request), fall back to manual approve
        if (error?.code !== 4001) {
          approveCallback();
        }
      });
  };

  const handleDismissConfirmation = useCallback(() => {
    setShowConfirm(false);
    setTxHash('');
  }, []);

  const onRemove = async () => {
    if (!chainId || !library || !account || !deadline)
      throw new Error('missing dependencies');
    const {
      [Field.CURRENCY_A]: currencyAmountA,
      [Field.CURRENCY_B]: currencyAmountB,
    } = parsedAmounts;
    if (!currencyAmountA || !currencyAmountB) {
      throw new Error('missing currency amounts');
    }
    const router = getRouterContract(chainId, library, account);

    const amountsMin = {
      [Field.CURRENCY_A]: calculateSlippageAmount(
        currencyAmountA,
        allowedSlippage,
      )[0],
      [Field.CURRENCY_B]: calculateSlippageAmount(
        currencyAmountB,
        allowedSlippage,
      )[0],
    };

    const liquidityAmount = parsedAmounts[Field.LIQUIDITY];
    if (!liquidityAmount) throw new Error('missing liquidity amount');

    const currencyBIsETH = currency1 === ETHER;
    const oneCurrencyIsETH = currency0 === ETHER || currencyBIsETH;

    if (!tokenA || !tokenB) throw new Error('could not wrap');

    let methodNames: string[],
      args: Array<string | string[] | number | boolean>;
    // we have approval, use normal remove liquidity
    if (approval === ApprovalState.APPROVED) {
      // removeLiquidityETH
      if (oneCurrencyIsETH) {
        methodNames = [
          'removeLiquidityETH',
          'removeLiquidityETHSupportingFeeOnTransferTokens',
        ];
        args = [
          currencyBIsETH ? tokenA.address : tokenB.address,
          liquidityAmount.raw.toString(),
          amountsMin[
            currencyBIsETH ? Field.CURRENCY_A : Field.CURRENCY_B
          ].toString(),
          amountsMin[
            currencyBIsETH ? Field.CURRENCY_B : Field.CURRENCY_A
          ].toString(),
          account,
          deadline.toHexString(),
        ];
      }
      // removeLiquidity
      else {
        methodNames = ['removeLiquidity'];
        args = [
          tokenA.address,
          tokenB.address,
          liquidityAmount.raw.toString(),
          amountsMin[Field.CURRENCY_A].toString(),
          amountsMin[Field.CURRENCY_B].toString(),
          account,
          deadline.toHexString(),
        ];
      }
    }
    // we have a signataure, use permit versions of remove liquidity
    else if (signatureData !== null) {
      // removeLiquidityETHWithPermit
      if (oneCurrencyIsETH) {
        methodNames = [
          'removeLiquidityETHWithPermit',
          'removeLiquidityETHWithPermitSupportingFeeOnTransferTokens',
        ];
        args = [
          currencyBIsETH ? tokenA.address : tokenB.address,
          liquidityAmount.raw.toString(),
          amountsMin[
            currencyBIsETH ? Field.CURRENCY_A : Field.CURRENCY_B
          ].toString(),
          amountsMin[
            currencyBIsETH ? Field.CURRENCY_B : Field.CURRENCY_A
          ].toString(),
          account,
          signatureData.deadline,
          false,
          signatureData.v,
          signatureData.r,
          signatureData.s,
        ];
      }
      // removeLiquidityETHWithPermit
      else {
        methodNames = ['removeLiquidityWithPermit'];
        args = [
          tokenA.address,
          tokenB.address,
          liquidityAmount.raw.toString(),
          amountsMin[Field.CURRENCY_A].toString(),
          amountsMin[Field.CURRENCY_B].toString(),
          account,
          signatureData.deadline,
          false,
          signatureData.v,
          signatureData.r,
          signatureData.s,
        ];
      }
    } else {
      throw new Error(
        'Attempting to confirm without approval or a signature. Please contact support.',
      );
    }

    const safeGasEstimates: (BigNumber | undefined)[] = await Promise.all(
      methodNames.map((methodName) =>
        router.estimateGas[methodName](...args)
          .then(calculateGasMargin)
          .catch((error) => {
            console.error(`estimateGas failed`, methodName, args, error);
            return undefined;
          }),
      ),
    );

    const indexOfSuccessfulEstimation = safeGasEstimates.findIndex(
      (safeGasEstimate) => BigNumber.isBigNumber(safeGasEstimate),
    );

    // all estimations failed...
    if (indexOfSuccessfulEstimation === -1) {
      console.error('This transaction would fail. Please contact support.');
    } else {
      const methodName = methodNames[indexOfSuccessfulEstimation];
      const safeGasEstimate = safeGasEstimates[indexOfSuccessfulEstimation];

      setAttemptingTxn(true);
      await router[methodName](...args, {
        gasLimit: safeGasEstimate,
      })
        .then(async (response: TransactionResponse) => {
          setAttemptingTxn(false);
          setTxPending(true);
          const summary =
            'Remove ' +
            parsedAmounts[Field.CURRENCY_A]?.toSignificant(3) +
            ' ' +
            currency0.symbol +
            ' and ' +
            parsedAmounts[Field.CURRENCY_B]?.toSignificant(3) +
            ' ' +
            currency1.symbol;

          addTransaction(response, {
            summary,
          });

          setTxHash(response.hash);

          try {
            const receipt = await response.wait();
            finalizedTransaction(receipt, {
              summary,
            });
            setTxPending(false);
          } catch (error) {
            setTxPending(false);
            setRemoveErrorMessage('There is an error in transaction.');
          }

          ReactGA.event({
            category: 'Liquidity',
            action: 'Remove',
            label: [currency0.symbol, currency1.symbol].join('/'),
          });
        })
        .catch((error: Error) => {
          setAttemptingTxn(false);
          // we only care if the error is something _other_ than the user rejected the tx
          console.error(error);
        });
    }
  };

  const modalHeader = () => {
    return (
      <Box>
        <Box mt={10} mb={3} display='flex' justifyContent='center'>
          <DoubleCurrencyLogo
            currency0={currency0}
            currency1={currency1}
            size={48}
          />
        </Box>
        <Box mb={6} color='#c7cad9' textAlign='center'>
          <Typography variant='h6'>
            Removing {formattedAmounts[Field.LIQUIDITY]} {currency0.symbol} /{' '}
            {currency1.symbol} LP Tokens
            <br />
            You will receive {parsedAmounts[Field.CURRENCY_A]?.toSignificant(
              2,
            )}{' '}
            {currency0.symbol} and{' '}
            {parsedAmounts[Field.CURRENCY_B]?.toSignificant(2)}{' '}
            {currency1.symbol}
          </Typography>
        </Box>
        <Box mb={3} color='#696c80' textAlign='center'>
          <Typography variant='body2'>
            {`Output is estimated. If the price changes by more than ${allowedSlippage /
              100}% your transaction will revert.`}
          </Typography>
        </Box>
        <Box mt={2}>
          <Button
            style={{ width: '100%' }}
            className={classes.removeButton}
            onClick={onRemove}
          >
            Confirm
          </Button>
        </Box>
      </Box>
    );
  };

  return (
    <CustomModal open={open} onClose={onClose}>
      <Box paddingX={3} paddingY={4}>
        {showConfirm && (
          <TransactionConfirmationModal
            isOpen={showConfirm}
            onDismiss={handleDismissConfirmation}
            attemptingTxn={attemptingTxn}
            txPending={txPending}
            hash={txHash}
            content={() =>
              removeErrorMessage ? (
                <TransactionErrorContent
                  onDismiss={handleDismissConfirmation}
                  message={removeErrorMessage}
                />
              ) : (
                <ConfirmationModalContent
                  title='Removing Liquidity'
                  onDismiss={handleDismissConfirmation}
                  content={modalHeader}
                />
              )
            }
            pendingText=''
            modalContent={
              txPending
                ? 'Submitted transaction to remove liquidity'
                : 'Successfully removed liquidity'
            }
          />
        )}
        <Box display='flex' alignItems='center' justifyContent='space-between'>
          <ArrowLeft
            color='#696c80'
            style={{ cursor: 'pointer' }}
            onClick={onClose}
          />
          <Typography variant='subtitle2' style={{ color: '#c7cad9' }}>
            Remove Liquidity
          </Typography>
          <CloseIcon style={{ cursor: 'pointer' }} onClick={onClose} />
        </Box>
        <Box
          mt={3}
          bgcolor='#12131a'
          border='1px solid rgba(105, 108, 128, 0.12)'
          borderRadius='10px'
          padding='16px'
        >
          <Box
            display='flex'
            alignItems='center'
            justifyContent='space-between'
          >
            <Typography variant='body2'>
              {currency0.symbol} / {currency1.symbol} LP
            </Typography>
            <Typography variant='body2'>
              Balance: {userPoolBalance?.toSignificant(3)}
            </Typography>
          </Box>
          <Box mt={2}>
            <input
              placeholder='0'
              className={classes.input}
              value={formattedAmounts[Field.LIQUIDITY]}
              onChange={(evt: any) => {
                onLiquidityInput(evt.target.value);
              }}
            />
          </Box>
          <Box display='flex' alignItems='center'>
            <Box flex={1} mr={2} mt={0.5}>
              <ColoredSlider
                min={1}
                max={100}
                step={1}
                value={innerLiquidityPercentage}
                onChange={(evt: any, value) =>
                  setInnerLiquidityPercentage(value as number)
                }
              />
            </Box>
            <Typography variant='body2'>
              {formattedAmounts[Field.LIQUIDITY_PERCENT]}%
            </Typography>
          </Box>
        </Box>
        <Box display='flex' my={3} justifyContent='center'>
          <ArrowDown color='#696c80' />
        </Box>
        <Box padding='16px' bgcolor='#252833' borderRadius='10px'>
          <Box
            display='flex'
            justifyContent='space-between'
            alignItems='center'
          >
            <Typography variant='body1'>Pooled {currency0.symbol}</Typography>
            <Box display='flex' alignItems='center'>
              <Typography variant='body1' style={{ marginRight: 6 }}>
                {token0Deposited?.toSignificant(2)}
              </Typography>
              <CurrencyLogo currency={currency0} />
            </Box>
          </Box>
          <Box
            mt={1}
            display='flex'
            justifyContent='space-between'
            alignItems='center'
          >
            <Typography
              variant='body1'
              style={{ color: 'rgba(68, 138, 255, 0.5)' }}
            >
              - Withdraw {currency0.symbol}
            </Typography>
            <Typography
              variant='body1'
              style={{ color: 'rgba(68, 138, 255, 0.5)' }}
            >
              {formattedAmounts[Field.CURRENCY_A]}
            </Typography>
          </Box>
          <Box
            mt={1}
            display='flex'
            justifyContent='space-between'
            alignItems='center'
          >
            <Typography variant='body1'>Pooled {currency1.symbol}</Typography>
            <Box display='flex' alignItems='center'>
              <Typography variant='body1' style={{ marginRight: 6 }}>
                {token1Deposited?.toSignificant(2)}
              </Typography>
              <CurrencyLogo currency={currency1} />
            </Box>
          </Box>
          <Box
            mt={1}
            display='flex'
            justifyContent='space-between'
            alignItems='center'
          >
            <Typography
              variant='body1'
              style={{ color: 'rgba(68, 138, 255, 0.5)' }}
            >
              - Withdraw {currency1.symbol}
            </Typography>
            <Typography
              variant='body1'
              style={{ color: 'rgba(68, 138, 255, 0.5)' }}
            >
              {formattedAmounts[Field.CURRENCY_B]}
            </Typography>
          </Box>
          <Box
            mt={1}
            display='flex'
            justifyContent='space-between'
            alignItems='center'
          >
            <Typography variant='body1'>Your Pool Share</Typography>
            <Typography variant='body1'>
              {poolTokenPercentage
                ? poolTokenPercentage.toSignificant() + '%'
                : '-'}
            </Typography>
          </Box>
        </Box>
        {pair && (
          <Box
            display='flex'
            mt={2}
            px={2}
            alignItems='center'
            justifyContent='space-between'
          >
            <Typography variant='body2'>
              1 {currency0.symbol} ={' '}
              {tokenA ? pair.priceOf(tokenA).toSignificant(6) : '-'}{' '}
              {currency1.symbol}
            </Typography>
            <Typography variant='body2'>
              1 {currency1.symbol} ={' '}
              {tokenB ? pair.priceOf(tokenB).toSignificant(6) : '-'}{' '}
              {currency0.symbol}
            </Typography>
          </Box>
        )}
        <Box
          mt={2}
          display='flex'
          alignItems='center'
          justifyContent='space-between'
        >
          <Button
            className={classes.removeButton}
            onClick={onAttemptToApprove}
            disabled={
              approval !== ApprovalState.NOT_APPROVED || signatureData !== null
            }
          >
            {approval === ApprovalState.PENDING
              ? 'Approving...'
              : approval === ApprovalState.APPROVED || signatureData !== null
              ? 'Approved'
              : 'Approve'}
          </Button>
          <Button
            className={classes.removeButton}
            onClick={() => {
              setShowConfirm(true);
            }}
            disabled={
              Boolean(error) ||
              (signatureData === null && approval !== ApprovalState.APPROVED)
            }
          >
            {error || 'Remove'}
          </Button>
        </Box>
        <Box mt={2}>
          <Typography variant='body1' style={{ color: '#ff5252' }}>
            {errorMsg}
          </Typography>
        </Box>
      </Box>
    </CustomModal>
  );
};

export default RemoveLiquidityModal;
