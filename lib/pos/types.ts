export interface PosItem {
  nama_barang: string;
  kode_barang: string;
  kategori: string;
  banyak_barang: number;
  harga_jual: number;
  sub_total: number;
  jumlah_retur: number;
  is_retur: boolean;
}

export interface PosTransaction {
  data_transaksi: PosItem[];
  sub_total: number;
  grand_total: number;
  kode: string;
  no_struk: number;
  timestamp: string;
  tipe_pembayaran: string;
}

export interface PosListResponse {
  status: string;
  data: PosTransaction[];
}

export interface PosRefreshResponse {
  status: string;
  data: {
    token: string;
    token_refresh: string;
  };
}
