import { ONE_BIPS } from './../constants/index'
import { Token, Currency, CurrencyAmount, TokenAmount, TradeType } from '@uniswap/sdk-core'
import { encodeRouteToPath, Route, Trade } from '@uniswap/v3-sdk'
import { BigNumber } from 'ethers'
import { useMemo } from 'react'
import { useSingleContractMultipleData } from '../state/multicall/hooks'
import { useAllV3Routes } from './useAllV3Routes'
import { useV3Quoter } from './useContract'
import { Percent } from '@uniswap/sdk-core'
import JSBI from 'jsbi'
import { BETTER_TRADE_LESS_HOPS_THRESHOLD, ONE_HUNDRED_PERCENT } from '../constants/index'

export enum V3TradeState {
  LOADING,
  INVALID,
  NO_ROUTE_FOUND,
  VALID,
  SYNCING,
}

/**
 * Returns the best v3 trade for a desired exact input swap
 * @param amountIn the amount to swap in
 * @param currencyOut the desired output currency
 */
export function useBestV3TradeExactIn(
  amountIn?: CurrencyAmount,
  currencyOut?: Currency
): { state: V3TradeState; trade: Trade | null } {
  const quoter = useV3Quoter()
  const { routes, loading: routesLoading } = useAllV3Routes(amountIn?.currency, currencyOut)

  const quoteExactInInputs = useMemo(() => {
    return routes.map((route) => [
      encodeRouteToPath(route, false),
      amountIn ? `0x${amountIn.raw.toString(16)}` : undefined,
    ])
  }, [amountIn, routes])

  const quotesResults = useSingleContractMultipleData(quoter, 'quoteExactInput', quoteExactInInputs)

  return useMemo(() => {
    if (!amountIn || !currencyOut) {
      return {
        state: V3TradeState.INVALID,
        trade: null,
      }
    }

    if (routesLoading || quotesResults.some(({ loading }) => loading)) {
      return {
        state: V3TradeState.LOADING,
        trade: null,
      }
    }

    const { bestRoute, amountOut } = quotesResults.reduce(
      (currentBest: { bestRoute: Route | null; amountOut: BigNumber | null }, { result }, i) => {
        if (!result) return currentBest

        if (currentBest.amountOut === null) {
          return {
            bestRoute: routes[i],
            amountOut: result.amountOut,
          }
        } else {
          const hopsCurrentBest = currentBest.bestRoute?.tokenPath?.length
          const hopsResult = routes[i].tokenPath.length
          const amountRatio = new Percent(JSBI.BigInt(currentBest.amountOut), JSBI.BigInt(result.amountOut))
          const belowThreshold = amountRatio.subtract(ONE_BIPS).lessThan(BETTER_TRADE_LESS_HOPS_THRESHOLD)
          const resultBetterThanCurrent = currentBest.amountOut.lt(result.amountOut)
          // result isnt better, but less hops and difference is < threshold --- if not just check if result is better
          if (
            (!resultBetterThanCurrent && hopsCurrentBest && belowThreshold && hopsResult < hopsCurrentBest) ||
            resultBetterThanCurrent
          ) {
            return {
              bestRoute: routes[i],
              amountOut: result.amountOut,
            }
          }
        }
        return currentBest
      },
      {
        bestRoute: null,
        amountOut: null,
      }
    )

    if (!bestRoute || !amountOut) {
      return {
        state: V3TradeState.NO_ROUTE_FOUND,
        trade: null,
      }
    }

    const isSyncing = quotesResults.some(({ syncing }) => syncing)

    return {
      state: isSyncing ? V3TradeState.SYNCING : V3TradeState.VALID,
      trade: Trade.createUncheckedTrade({
        route: bestRoute,
        tradeType: TradeType.EXACT_INPUT,
        inputAmount: amountIn,
        outputAmount:
          currencyOut instanceof Token
            ? new TokenAmount(currencyOut, amountOut.toString())
            : CurrencyAmount.ether(amountOut.toString()),
      }),
    }
  }, [amountIn, currencyOut, quotesResults, routes, routesLoading])
}

/**
 * Returns the best v3 trade for a desired exact output swap
 * @param currencyIn the desired input currency
 * @param amountOut the amount to swap out
 */
export function useBestV3TradeExactOut(
  currencyIn?: Currency,
  amountOut?: CurrencyAmount
): { state: V3TradeState; trade: Trade | null } {
  const quoter = useV3Quoter()
  const { routes, loading: routesLoading } = useAllV3Routes(currencyIn, amountOut?.currency)

  const quoteExactOutInputs = useMemo(() => {
    return routes.map((route) => [
      encodeRouteToPath(route, true),
      amountOut ? `0x${amountOut.raw.toString(16)}` : undefined,
    ])
  }, [amountOut, routes])

  const quotesResults = useSingleContractMultipleData(quoter, 'quoteExactOutput', quoteExactOutInputs)

  return useMemo(() => {
    if (!amountOut || !currencyIn || quotesResults.some(({ valid }) => !valid)) {
      return {
        state: V3TradeState.INVALID,
        trade: null,
      }
    }

    if (routesLoading || quotesResults.some(({ loading }) => loading)) {
      return {
        state: V3TradeState.LOADING,
        trade: null,
      }
    }

    const { bestRoute, amountIn } = quotesResults.reduce(
      (currentBest: { bestRoute: Route | null; amountIn: BigNumber | null }, { result }, i) => {
        if (!result) return currentBest

        if (currentBest.amountIn === null) {
          return {
            bestRoute: routes[i],
            amountIn: result.amountIn,
          }
        } else {
          const hopsCurrentBest = currentBest.bestRoute?.tokenPath?.length
          const hopsResult = routes[i].tokenPath.length
          const amountRatio = new Percent(JSBI.BigInt(result.amountIn), JSBI.BigInt(currentBest.amountIn))
          // calculate % difference in output amounts, see if result has lower amount in
          const belowThreshold = ONE_HUNDRED_PERCENT.subtract(amountRatio).greaterThan(BETTER_TRADE_LESS_HOPS_THRESHOLD)
          const resultBetterThanCurrent = currentBest.amountIn.gt(result.amountIn)
          // result isnt better, but less hops and difference is < threshold
          if (
            (hopsCurrentBest && !resultBetterThanCurrent && belowThreshold && hopsResult < hopsCurrentBest) ||
            resultBetterThanCurrent
          ) {
            return {
              bestRoute: routes[i],
              amountIn: result.amountIn,
            }
          }
        }

        return currentBest
      },
      {
        bestRoute: null,
        amountIn: null,
      }
    )

    if (!bestRoute || !amountIn) {
      return {
        state: V3TradeState.NO_ROUTE_FOUND,
        trade: null,
      }
    }

    const isSyncing = quotesResults.some(({ syncing }) => syncing)

    return {
      state: isSyncing ? V3TradeState.SYNCING : V3TradeState.VALID,
      trade: Trade.createUncheckedTrade({
        route: bestRoute,
        tradeType: TradeType.EXACT_OUTPUT,
        inputAmount:
          currencyIn instanceof Token
            ? new TokenAmount(currencyIn, amountIn.toString())
            : CurrencyAmount.ether(amountIn.toString()),
        outputAmount: amountOut,
      }),
    }
  }, [amountOut, currencyIn, quotesResults, routes, routesLoading])
}
