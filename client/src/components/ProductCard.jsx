import { Link } from 'react-router-dom';

import { money } from '../api';
import { useShop } from '../store';
import { Star } from './Icons';

export function Rating({ value, count }) {
  return (
    <span className="stars" title={`${value} out of 5`}>
      <Star width={13} height={13} />
      {value.toFixed(1)}
      {count != null && <span>({count.toLocaleString()})</span>}
    </span>
  );
}

export default function ProductCard({ product }) {
  const { addItem } = useShop();
  const onSale = product.compareAtPrice && product.compareAtPrice > product.price;

  return (
    <article className="card">
      <Link to={`/product/${product.id}`} className="card-media">
        {!product.inStock ? (
          <span className="badge out">Sold out</span>
        ) : onSale ? (
          <span className="badge sale">
            Save {Math.round((1 - product.price / product.compareAtPrice) * 100)}%
          </span>
        ) : product.featured ? (
          <span className="badge">Featured</span>
        ) : null}
        <img
          src={product.image.thumb}
          srcSet={product.image.srcset}
          sizes="(max-width: 700px) 45vw, 260px"
          width={product.image.width}
          height={product.image.height}
          alt={product.name}
          loading="lazy"
        />
      </Link>

      <div className="card-body">
        <span className="card-cat">{product.category}</span>
        <Link to={`/product/${product.id}`} className="card-name">{product.name}</Link>
        <p className="card-tag">{product.tagline}</p>
        <Rating value={product.rating} count={product.reviews} />
        <div className="card-foot">
          <span className="price">
            {money(product.price)}
            {onSale && <s>{money(product.compareAtPrice)}</s>}
          </span>
          <button
            type="button"
            className="btn sm"
            disabled={!product.inStock}
            onClick={() => addItem(product)}
          >
            Add
          </button>
        </div>
      </div>
    </article>
  );
}
